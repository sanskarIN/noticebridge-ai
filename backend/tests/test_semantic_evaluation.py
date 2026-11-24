"""Exercise the local AI evaluator without a running model or private notices."""

import hashlib
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread

import pytest

from noticebridge import semantic
from noticebridge.compare import compare_documents
from noticebridge.extract import extract_pdf

BENCHMARKS = Path(__file__).resolve().parents[1] / "benchmarks"
sys.path.insert(0, str(BENCHMARKS))
import evaluate_semantic as evaluation  # noqa: E402

PAIR = {
    "original_page": 1, "original_text": "Deadline: 13 December 2026",
    "revised_page": 1, "revised_text": "Apply by 14 December 2026",
}


@pytest.fixture
def dataset(tmp_path, pdf_bytes):
    case = {
        "id": "fixture", "source_kind": "fictional", "label_method": "author_reviewed",
        "expected_pairs": [PAIR],
    }
    for role in ("original", "revised"):
        filename = f"{role}.pdf"
        data = pdf_bytes([[PAIR[f"{role}_text"]]])
        (tmp_path / filename).write_bytes(data)
        case[role] = filename
        case[f"{role}_sha256"] = hashlib.sha256(data).hexdigest()
    manifest = tmp_path / "labels.json"
    save(manifest, {"version": 2, "cases": [case]})
    return manifest


def save(manifest, payload):
    manifest.write_text(json.dumps(payload), encoding="utf-8")


@pytest.fixture
def worker(monkeypatch):
    calls = []

    def run(original, revised, *, enable_semantic, **options):
        calls.append((enable_semantic, options))
        result = compare_documents(
            extract_pdf(original, document_id="original", filename=options["old_name"]),
            extract_pdf(revised, document_id="revised", filename=options["new_name"]),
        )
        result.automatic_ocr = options["enable_ocr"]
        if not enable_semantic:
            return result
        old = next(f.id for f in result.findings if f.original)
        new = next(f.id for f in result.findings if f.revised)
        monkeypatch.setattr(
            semantic, "_model_pairs",
            lambda *args: {"pairs": [{"original_id": old, "revised_id": new}]},
        )
        return semantic.propose_semantic_matches(result)

    monkeypatch.setattr(evaluation, "run_isolated_comparison", run)
    return calls


def test_incremental_evaluation_two_modes_no_quotes(dataset, worker):
    result = evaluation.evaluate_semantic(dataset)
    assert [mode for mode, _ in worker] == [False, True]
    assert worker[0][1] == worker[1][1]
    overall = result["overall"]
    assert overall["baseline"]["recall"] == 0
    assert overall["assisted"]["recall"] == 1
    assert overall["incremental_proposal_precision"] == 1
    assert overall["baseline_miss_recovery"] == 1
    assert overall["outcomes"]["proposals_added"] == 1
    assert result["declared_independent_nonfictional"]["case_count"] == 0
    assert PAIR["original_text"] not in json.dumps(result)
    assert PAIR["revised_text"] not in json.dumps(result)


@pytest.mark.parametrize(("gold", "recovered", "unsupported", "recall"), [
    ([], 0, 1, None),
    ([PAIR, PAIR], 1, 0, 0.5),
])
def test_false_proposals_and_duplicate_gold(dataset, worker, gold, recovered, unsupported, recall):
    payload = json.loads(dataset.read_bytes())
    payload["cases"][0]["expected_pairs"] = gold
    save(dataset, payload)
    overall = evaluation.evaluate_semantic(dataset)["overall"]
    assert overall["recovered_pair_count"] == recovered
    assert overall["unsupported_or_redundant_proposal_count"] == unsupported
    assert overall["assisted"]["recall"] == recall


@pytest.mark.parametrize("mutation", ["finding", "checklist", "coverage", "warning", "confirmed"])
def test_assisted_cannot_change_deterministic_report(dataset, worker, monkeypatch, mutation):
    actual = evaluation.run_isolated_comparison

    def modified(*args, **kwargs):
        result = actual(*args, **kwargs)
        if kwargs["enable_semantic"]:
            if mutation == "finding":
                result.findings.pop(0)
            elif mutation == "checklist":
                result.checklist.pop(0)
            elif mutation == "coverage":
                result.text_coverage = "partial"
            elif mutation == "warning":
                result.warnings.insert(0, "altered")
            else:
                result.findings[-1].status = "confirmed_change"
        if mutation == "warning" and not kwargs["enable_semantic"]:
            result.warnings.append("baseline")
        return result

    monkeypatch.setattr(evaluation, "run_isolated_comparison", modified)
    with pytest.raises(ValueError, match="did not preserve"):
        evaluation.evaluate_semantic(dataset)


@pytest.mark.parametrize("mutation", ["legacy", "hash", "page"])
def test_invalid_inputs_fail_before_model(dataset, worker, mutation):
    payload = json.loads(dataset.read_bytes())
    if mutation == "legacy":
        payload["version"] = 1
    elif mutation == "hash":
        payload["cases"][0]["original_sha256"] = "a" * 64
    else:
        payload["cases"][0]["expected_pairs"][0]["original_page"] = 2
    save(dataset, payload)
    with pytest.raises(ValueError):
        evaluation.evaluate_semantic(dataset)
    assert all(not mode for mode, _ in worker)


def test_independent_gates_do_not_credit_fictional_results(dataset, worker, capsys):
    args = [str(dataset), "--run-local-model", "--min-independent-proposal-precision", "0"]
    assert evaluation.main(args) == 1
    capsys.readouterr()
    payload = json.loads(dataset.read_bytes())
    # Declarations exercise the gate only; the fixture is not real-world evidence.
    payload["cases"][0].update(source_kind="consented", label_method="independent_human")
    save(dataset, payload)
    assert evaluation.main(args) == 0
    assert json.loads(capsys.readouterr().out)["declared_independent_nonfictional"][
        "incremental_proposal_precision"
    ] == 1
    payload["cases"].append({**payload["cases"][0], "id": "duplicate"})
    save(dataset, payload)
    assert evaluation.main(args + ["--min-independent-distinct-pairs", "1"]) == 1


@pytest.mark.parametrize("outcome", ["unavailable", "no_candidates", "no_verified_pairs"])
def test_unexercised_model_does_not_pass(dataset, worker, monkeypatch, capsys, outcome):
    actual = evaluation.run_isolated_comparison

    def no_proposal(*args, **kwargs):
        result = actual(*args, **{**kwargs, "enable_semantic": False})
        if kwargs["enable_semantic"]:
            result.semantic_assistance = outcome
        return result

    monkeypatch.setattr(evaluation, "run_isolated_comparison", no_proposal)
    assert evaluation.main([str(dataset), "--run-local-model"]) == 1
    overall = json.loads(capsys.readouterr().out)["overall"]
    assert overall["outcomes"][outcome] == 1
    assert overall["incremental_proposal_precision"] is None


def test_explicit_model_opt_in_required(dataset, worker):
    with pytest.raises(SystemExit) as error:
        evaluation.main([str(dataset)])
    assert error.value.code == 2
    assert not worker


@pytest.mark.skipif(
    os.environ.get("GITHUB_ACTIONS") != "true",
    reason="Fixed loopback test port must not interfere with a developer's local model",
)
def test_real_isolated_workers_with_controlled_loopback_model(dataset, monkeypatch):
    """Exercise worker isolation, the actual HTTP transport and provenance checks."""
    requests = []
    malformed = False

    class ModelHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, payload))
            if malformed:
                # Duplicate envelope keys are rejected rather than interpreted
                # according to the JSON decoder's last-member-wins behavior.
                response = b'{"response":"{}","response":"{}"}'
            else:
                excerpts = json.loads(payload["prompt"].split("\n", 1)[1])
                pairs = [{
                    "original_id": excerpts["original"][0]["id"],
                    "revised_id": excerpts["revised"][0]["id"],
                }]
                response = json.dumps({"response": json.dumps({"pairs": pairs})}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *args):
            pass

    # CI is an isolated host. Never contact another process if the port is taken.
    try:
        server = HTTPServer(("127.0.0.1", 11434), ModelHandler)
    except OSError:
        pytest.skip("Local test model port is occupied")
    monkeypatch.setenv("NOTICEBRIDGE_LOCAL_MODEL", "noticebridge-ci-fixture")
    with server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = evaluation.evaluate_semantic(dataset)
            assert result["overall"]["recovered_pair_count"] == 1
            assert result["overall"]["outcomes"]["proposals_added"] == 1
            assert len(requests) == 1
            path, payload = requests[0]
            assert path == "/api/generate"
            assert payload["model"] == "noticebridge-ci-fixture"
            assert payload["stream"] is False
            excerpts = json.loads(payload["prompt"].split("\n", 1)[1])
            assert excerpts["original"][0]["text"] == PAIR["original_text"]
            assert excerpts["revised"][0]["text"] == PAIR["revised_text"]
            assert all(
                set(entry) == {"id", "category", "text"}
                for role in ("original", "revised") for entry in excerpts[role]
            )

            malformed = True
            failed = evaluation.evaluate_semantic(dataset)
            assert failed["overall"]["outcomes"]["unavailable"] == 1
            assert failed["overall"]["baseline"] == failed["overall"]["assisted"]
            assert failed["overall"]["proposal_count"] == 0
            assert len(requests) == 2
        finally:
            server.shutdown()
            thread.join(timeout=5)
