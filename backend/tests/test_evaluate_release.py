"""Exercise the release evaluation gate with fictional PDFs and test-only metadata."""

import hashlib
import json
import sys
from pathlib import Path

import pytest

BENCHMARKS = Path(__file__).resolve().parents[1] / "benchmarks"
sys.path.insert(0, str(BENCHMARKS))
import evaluate_labeled  # noqa: E402
import evaluate_release  # noqa: E402
from reconcile_labeled_reviews import reconcile_reviews  # noqa: E402

QUOTE = "Application deadline: 19 December 2026"
POLICY = {
    "min_cases": 2,
    "min_issuer_groups": 2,
    "min_precision": 1,
    "min_recall": 1,
    "max_unsupported_confirmed": 0,
    "max_incomplete_cases": 0,
    "max_unchecked_image_cases": 0,
    "max_limited_matching_cases": 0,
    "enable_ocr": False,
}


def _save(path, payload):
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


@pytest.fixture
def corpus(tmp_path, pdf_bytes):
    def case(case_id, issuer):
        pair = {
            "original_page": 1, "original_text": QUOTE,
            "revised_page": 1, "revised_text": "Application deadline: 13 December 2026",
        }
        data = {
            "id": case_id, "source_kind": "public_notice", "label_method": "independent_human",
            "review_complete": True, "expected_pairs": [pair], "issuer_group": issuer,
            "event_group": case_id,
        }
        for role in ("original", "revised"):
            filename = f"{case_id}-{role}.pdf"
            pdf = pdf_bytes([["Fictional evaluation fixture " + issuer, pair[f"{role}_text"]]])
            (tmp_path / filename).write_bytes(pdf)
            data[role] = filename
            data[f"{role}_sha256"] = hashlib.sha256(pdf).hexdigest()
        return data

    cases = [case("case-1", "issuer-1"), case("case-2", "issuer-2")]
    return {
        "development": _save(tmp_path / "development.json", {
            "version": 2, "cases": [case("development", "issuer-dev")],
        }),
        "heldout": tmp_path / "heldout.json",
        "review-a": _save(tmp_path / "a.json", {"version": 2, "cases": cases}),
        "review-b": _save(tmp_path / "b.json", {"version": 2, "cases": cases}),
        "reviewer-a": "reviewer-a",
        "reviewer-b": "reviewer-b",
        "plan": tmp_path / "plan.json",
    }


def _reconcile(corpus, **options):
    _, resolved = reconcile_reviews(
        corpus["review-a"], corpus["review-b"], reviewer_a=corpus["reviewer-a"],
        reviewer_b=corpus["reviewer-b"], **options,
    )
    assert resolved is not None
    _save(corpus["heldout"], resolved)


def _cli(corpus, command, **options):
    args = [command]
    for key, value in (corpus | options).items():
        args.extend((f"--{key}", str(value)))
    return evaluate_release.main(args)


def _freeze(corpus, capsys, **options):
    policy_file = _save(corpus["plan"].with_name("policy.json"), POLICY)
    assert _cli(corpus, "freeze", policy=policy_file, **options) == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["plan_sha256"] == hashlib.sha256(corpus["plan"].read_bytes()).hexdigest()
    return summary["plan_sha256"]


def test_freeze_and_score_real_worker_with_no_quote_output(corpus, capsys):
    _reconcile(corpus)
    digest = _freeze(corpus, capsys)
    assert _cli(corpus, "score", **{"plan-sha256": digest}) == 0
    output = capsys.readouterr().out
    report = json.loads(output)
    assert QUOTE not in output and "case-1-original.pdf" not in output
    assert report["plan_sha256"] == digest
    assert report["plan"]["heldout_issuer_group_count"] == 2
    assert report["evaluation"]["manifest_sha256"] == report["plan"]["heldout_manifest_sha256"]
    assert report["evaluation"]["ocr_enabled"] is False
    assert report["checks"]["min_precision"] == {
        "numerator": 2, "denominator": 2, "threshold": 1, "passed": True,
    }
    assert all(check["passed"] for check in report["checks"].values())


def test_freeze_does_not_score_and_cannot_overwrite(corpus, capsys, monkeypatch):
    _reconcile(corpus)
    monkeypatch.setattr(evaluate_release, "evaluate_labeled", _unexpected_score)
    _freeze(corpus, capsys)
    saved = corpus["plan"].read_bytes()
    with pytest.raises(SystemExit) as error:
        _cli(corpus, "freeze", policy=corpus["plan"].with_name("policy.json"))
    assert error.value.code == 2
    assert corpus["plan"].read_bytes() == saved


def _unexpected_score(*args, **kwargs):
    pytest.fail("Preflight should stop before scoring")


@pytest.mark.parametrize("changed", ["plan", "development", "heldout", "review-a", "pdf"])
def test_changed_plan_or_input_is_rejected_before_scoring(corpus, changed, capsys, monkeypatch):
    _reconcile(corpus)
    digest = _freeze(corpus, capsys)
    monkeypatch.setattr(evaluate_release, "evaluate_labeled", _unexpected_score)
    if changed == "plan":
        with corpus["plan"].open("ab") as handle:
            handle.write(b"\n")
    elif changed == "pdf":
        with corpus["heldout"].with_name("case-1-original.pdf").open("ab") as handle:
            handle.write(b"\n")
    else:
        path = corpus[changed]
        payload = json.loads(path.read_bytes())
        payload["changed_metadata"] = True
        _save(path, payload)
    with pytest.raises(SystemExit) as error:
        _cli(corpus, "score", **{"plan-sha256": digest})
    assert error.value.code == 2
    stdout, stderr = capsys.readouterr()
    assert not stdout and "error:" in stderr and QUOTE not in stderr


@pytest.mark.parametrize("overlap", ["bytes", "declared_event", "missing_group", "repeated_pair"])
def test_split_rules_block_freeze(corpus, capsys, overlap):
    _reconcile(corpus)
    path = corpus["development"]
    development = json.loads(path.read_bytes())
    heldout = json.loads(corpus["heldout"].read_bytes())["cases"][0]
    case = development["cases"][0]
    if overlap == "bytes":
        case.update(original=heldout["revised"], original_sha256=heldout["revised_sha256"])
    elif overlap == "declared_event":
        case.update(
            issuer_group=heldout["issuer_group"].upper(), event_group=heldout["event_group"],
        )
    elif overlap == "missing_group":
        del case["issuer_group"], case["event_group"]
    else:
        development["cases"].append({**case, "id": "repeat"})
    _save(path, development)
    policy_file = _save(path.with_name("policy.json"), POLICY)
    with pytest.raises(SystemExit) as error:
        _cli(corpus, "freeze", policy=policy_file)
    assert error.value.code == 2
    assert "Split audit failed" in capsys.readouterr().err
    assert not corpus["plan"].exists()


@pytest.mark.parametrize(("changes", "message"), [
    ({"source_kind": "fictional"}, "public_notice or consented"),
    ({"expected_pairs": []}, "positive pair"),
    ({"issuer_group": "same-issuer"}, "below min_issuer_groups"),
])
def test_corpus_requires_eligible_declarations_and_measurable_diversity(
    corpus, capsys, changes, message,
):
    for role in ("review-a", "review-b"):
        path = corpus[role]
        payload = json.loads(path.read_bytes())
        for case in payload["cases"]:
            case.update(changes)
        _save(path, payload)
    _reconcile(corpus)
    policy_file = _save(corpus["plan"].with_name("policy.json"), POLICY)
    with pytest.raises(SystemExit) as error:
        _cli(corpus, "freeze", policy=policy_file)
    assert error.value.code == 2
    assert message in capsys.readouterr().err


def test_adjudicated_labels_are_scored_and_report_gate_failures(corpus, capsys):
    alternate = json.loads(corpus["review-b"].read_bytes())
    alternate["cases"][0]["expected_pairs"] = []
    _save(corpus["review-b"], alternate)
    decision = _save(corpus["plan"].with_name("adjudication.json"), {
        "version": 2, "cases": [alternate["cases"][0]],
    })
    _reconcile(corpus, adjudication_path=decision, adjudicator="reviewer-c")
    options = {"adjudication": decision, "adjudicator": "reviewer-c"}
    digest = _freeze(corpus, capsys, **options)
    assert _cli(corpus, "score", **options, **{"plan-sha256": digest}) == 1
    report = json.loads(capsys.readouterr().out)
    assert not report["passed"]
    assert not report["checks"]["min_precision"]["passed"]
    assert not report["checks"]["max_unsupported_confirmed"]["passed"]
    assert report["checks"]["min_recall"]["passed"]


def test_manifest_binding_is_checked_before_opening_pdfs(corpus, monkeypatch):
    _reconcile(corpus)
    monkeypatch.setattr(evaluate_labeled, "_pdf", _unexpected_score)
    with pytest.raises(ValueError, match="changed after preflight"):
        evaluate_labeled.evaluate_labeled(corpus["heldout"], expected_manifest_sha256="0" * 64)


@pytest.mark.parametrize(("true_positive", "false_positive", "threshold"), [
    (89999, 10001, 0.9),  # A displayed 0.9000 would incorrectly pass.
    (0, 0, 0),          # Undefined precision still fails a zero minimum.
])
def test_uses_raw_pair_counts_and_checks_each_coverage_limit(
    tmp_path, monkeypatch, true_positive, false_positive, threshold,
):
    result = {
        "pair_counts": {
            "true_positive": true_positive, "false_positive": false_positive,
            "false_negative": 1, "unsupported_confirmed_changes": 0,
        },
        "incomplete_case_count": 1,
        "unchecked_image_case_count": 1,
        "fuzzy_matching_limited_case_count": 1,
    }
    monkeypatch.setattr(evaluate_release, "evaluate_labeled", lambda *args, **kwargs: result)
    report = evaluate_release.score_plan(
        tmp_path / "labels.json",
        {"policy": {**POLICY, "min_precision": threshold}, "heldout_manifest_sha256": "a" * 64},
        plan_sha256="b" * 64,
    )
    assert not report["passed"]
    assert not report["checks"]["min_precision"]["passed"]
    for key in ("max_incomplete_cases", "max_unchecked_image_cases", "max_limited_matching_cases"):
        assert report["checks"][key] == {"observed": 1, "threshold": 0, "passed": False}


@pytest.mark.parametrize(("key", "invalid"), [
    ("min_cases", True), ("min_issuer_groups", 0), ("min_precision", float("nan")),
    ("min_recall", 1.01), ("max_incomplete_cases", -1), ("enable_ocr", 1),
])
def test_policy_rejects_invalid_types_and_ranges(key, invalid):
    with pytest.raises(ValueError, match=key):
        evaluate_release._validate_policy({**POLICY, key: invalid})
