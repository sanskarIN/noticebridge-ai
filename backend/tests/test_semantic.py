"""Optional local-model assistance must never invent or confirm PDF evidence."""

import json

import httpx
import pytest

from noticebridge import semantic
from noticebridge.compare import compare_documents
from noticebridge.extract import extract_pdf


@pytest.fixture
def unmatched_report(pdf_bytes):
    old = extract_pdf(
        pdf_bytes([["Deadline: 13 December 2026"]]),
        document_id="original", filename="old.pdf",
    )
    new = extract_pdf(
        pdf_bytes([["Apply by 14 December 2026"]]),
        document_id="revised", filename="new.pdf",
    )
    result = compare_documents(old, new)
    assert len(result.findings) == 2
    assert all(item.status == "missing_information" for item in result.findings)
    return result


def test_opt_in_model_pairing_remains_unverified_and_preserves_citations(
    monkeypatch, unmatched_report
):
    old_id = next(f.id for f in unmatched_report.findings if f.original)
    new_id = next(f.id for f in unmatched_report.findings if f.revised)
    original_text = next(f.original.text for f in unmatched_report.findings if f.original)
    revised_text = next(f.revised.text for f in unmatched_report.findings if f.revised)

    def propose(old, new):
        assert old[0]["id"] == old_id
        assert new[0]["id"] == new_id
        assert old[0]["text"] == original_text
        assert new[0]["text"] == revised_text
        return {"pairs": [{"original_id": old_id, "revised_id": new_id}]}

    monkeypatch.setattr(semantic, "_model_pairs", propose)
    result = semantic.propose_semantic_matches(unmatched_report)
    assert result.semantic_assistance == "proposals_added"
    assert len(result.findings) == 3
    assert sum(f.status == "missing_information" for f in result.findings) == 2
    proposal = next(f for f in result.findings if f.match_method == "semantic_proposal")
    assert proposal.status == "possible_change"
    assert proposal.match_method == "semantic_proposal"
    assert proposal.original.text == original_text
    assert proposal.revised.text == revised_text
    assert proposal.original.page == proposal.revised.page == 1
    assert not proposal.authority_verified
    assert not proposal.field_changes
    assert len(result.checklist) == 3
    assert any(item.finding_id == proposal.id for item in result.checklist)
    assert [f.model_dump() for f in result.findings[:2]] == [
        f.model_dump() for f in unmatched_report.findings
    ]
    assert unmatched_report.semantic_assistance == "not_requested"

    # Proposals and deterministic citations must not share mutable objects.
    unmatched_original = next(f.original for f in result.findings if
                              f.status == "missing_information" and f.original)
    unmatched_revised = next(f.revised for f in result.findings if
                             f.status == "missing_information" and f.revised)
    assert proposal.original is not unmatched_original
    assert proposal.revised is not unmatched_revised
    proposal.original.text = "Untrusted rewritten quotation"
    assert unmatched_original.text == original_text


@pytest.mark.parametrize("response", [
    {"pairs": [{"original_id": "invented", "revised_id": "f9999"}]},
    {"pairs": [{"original_id": 123, "revised_id": "f1"}]},
    {"pairs": "not a list"},
    {"pairs": [{"original_id": "f1", "revised_id": "f9999"}]},
    {"wrong": []},
])
def test_invented_or_malformed_model_ids_cannot_change_findings(
    monkeypatch, unmatched_report, response
):
    monkeypatch.setattr(semantic, "_model_pairs", lambda *args: response)
    before = unmatched_report.model_dump()
    result = semantic.propose_semantic_matches(unmatched_report)
    assert result.semantic_assistance == "no_verified_pairs"
    assert all(f.status == "missing_information" for f in result.findings)
    assert [f.id for f in result.findings] == [f["id"] for f in before["findings"]]
    assert all(not f.authority_verified for f in result.findings)


def test_duplicate_ai_suggestions_are_never_double_counted(monkeypatch, unmatched_report):
    old_id = next(f.id for f in unmatched_report.findings if f.original)
    new_id = next(f.id for f in unmatched_report.findings if f.revised)
    pair = {"original_id": old_id, "revised_id": new_id}
    monkeypatch.setattr(semantic, "_model_pairs", lambda *args: {"pairs": [pair, pair]})
    result = semantic.propose_semantic_matches(unmatched_report)
    assert len(result.findings) == 3
    proposals = [f for f in result.findings if f.match_method == "semantic_proposal"]
    assert len(proposals) == 1
    assert proposals[0].status == "possible_change"


def test_offline_model_does_not_break_deterministic_comparison(
    monkeypatch, unmatched_report
):
    def unavailable(*args):
        raise httpx.ConnectError("Ollama offline")
    monkeypatch.setattr(semantic, "_model_pairs", unavailable)
    result = semantic.propose_semantic_matches(unmatched_report)
    assert result.semantic_assistance == "unavailable"
    assert len(result.findings) == 2
    assert any("deterministic comparison was preserved" in w for w in result.warnings)


def test_model_request_is_fixed_to_localhost_and_no_proxy(monkeypatch):
    calls = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def raise_for_status(self):
            return None

        def iter_bytes(self):
            yield b'{"response":"{\\"pairs\\":[]}"}'

    class Client:
        def __init__(self, **kwargs):
            calls.append(("options", kwargs))

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, json):
            calls.append(("stream", (method, url, json)))
            return Response()

    monkeypatch.setattr(semantic.httpx, "Client", Client)
    result = semantic._model_pairs(
        [{"id": "f1", "category": "deadline", "text": "Deadline changed"}],
        [{"id": "f2", "category": "deadline", "text": "Apply by date updated"}],
    )
    assert result == {"pairs": []}
    assert calls[0][1]["trust_env"] is False
    assert calls[1][1][0] == "POST"
    assert calls[1][1][1] == "http://127.0.0.1:11434/api/generate"
    assert calls[1][1][2]["stream"] is False


def test_oversized_local_model_http_response_rejected_before_json(monkeypatch):
    class HugeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def raise_for_status(self):
            return None

        def iter_bytes(self):
            yield b'{"response":"'
            yield b"A" * (semantic.MAX_MODEL_RESPONSE_BYTES + 1)

    class Client:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def stream(self, *args, **kwargs):
            return HugeResponse()

    monkeypatch.setattr(semantic.httpx, "Client", Client)
    with pytest.raises(ValueError, match="exceeds the allowed size"):
        semantic._model_pairs(
            [{"id": "f1", "category": "deadline", "text": "Old"}],
            [{"id": "f2", "category": "deadline", "text": "New"}],
        )


def test_bad_model_name_is_not_sent_to_ollama(monkeypatch):
    monkeypatch.setenv("NOTICEBRIDGE_LOCAL_MODEL", "qwen; external")
    with pytest.raises(ValueError, match="Invalid local model name"):
        semantic._model_pairs([], [])


def test_only_shared_categories_are_eligible(monkeypatch, pdf_bytes):
    old = extract_pdf(
        pdf_bytes([["Deadline: 13 December 2026"]]),
        document_id="original", filename="old.pdf",
    )
    new = extract_pdf(
        pdf_bytes([["Application fee: INR 300"]]),
        document_id="revised", filename="new.pdf",
    )
    report = compare_documents(old, new)
    def forbidden(*args):
        raise AssertionError("No shared categories; model must not run")
    monkeypatch.setattr(semantic, "_model_pairs", forbidden)
    result = semantic.propose_semantic_matches(report)
    assert result.semantic_assistance == "no_candidates"
    assert all(f.status == "missing_information" for f in result.findings)


@pytest.mark.parametrize("raw", [
    '{"pairs":[],"pairs":[]}',
    '{"pairs":[{"original_id":"f1","original_id":"f2","revised_id":"f3"}]}',
    '{"pairs":[],"score":NaN}',
    '{"pairs":[],"score":Infinity}',
])
def test_model_json_rejects_ambiguous_or_nonstandard_members(raw):
    with pytest.raises(ValueError):
        semantic._decode_model_json(raw)


def test_local_model_malformed_envelope_and_inner_json_are_rejected(monkeypatch):
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def raise_for_status(self):
            pass

        def iter_bytes(self):
            yield raw

    class Client:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def stream(self, *args, **kwargs):
            return Response()

    monkeypatch.setattr(semantic.httpx, "Client", Client)
    for raw in (
        b'{"response":"{}","response":"{}"}',
        json.dumps({"response": '{"pairs":[],"pairs":[]}'}).encode(),
    ):
        with pytest.raises(ValueError, match="Duplicate field"):
            semantic._model_pairs([], [])


def test_deeply_nested_model_json_preserves_deterministic_report(monkeypatch, unmatched_report):
    def malformed(*args):
        return semantic._decode_model_json("[" * 4000 + "]" * 4000)

    monkeypatch.setattr(semantic, "_model_pairs", malformed)
    result = semantic.propose_semantic_matches(unmatched_report)
    assert result.semantic_assistance == "unavailable"
    assert result.findings == unmatched_report.findings
    assert result.checklist == unmatched_report.checklist


@pytest.mark.parametrize("extra", ["authority_verified", "confidence", "explanation"])
def test_model_extra_pair_claims_are_not_admitted(monkeypatch, unmatched_report, extra):
    old = next(f.id for f in unmatched_report.findings if f.original)
    new = next(f.id for f in unmatched_report.findings if f.revised)
    answer = {"pairs": [{"original_id": old, "revised_id": new, extra: True}]}
    monkeypatch.setattr(semantic, "_model_pairs", lambda *args: answer)
    result = semantic.propose_semantic_matches(unmatched_report)
    assert result.semantic_assistance == "no_verified_pairs"
    assert result.findings == unmatched_report.findings


def _expanded_unmatched(report):
    """Construct distinct unmatched sources without depending on fuzzy thresholds."""
    expanded = report.model_copy(deep=True)
    for role in ("original", "revised"):
        seed = next(f for f in report.findings if getattr(f, role))
        for index in (2, 3):
            finding = seed.model_copy(deep=True)
            finding.id = f"{role}-{index}"
            evidence = getattr(finding, role)
            evidence.text += f" phase {index}"
            expanded.findings.append(finding)
    return expanded


@pytest.mark.parametrize("reverse", [False, True])
def test_conflicting_model_edges_are_rejected_independent_of_order(
    monkeypatch, unmatched_report, reverse,
):
    report = _expanded_unmatched(unmatched_report)
    old = next(f.id for f in report.findings if f.original)
    new = next(f.id for f in report.findings if f.revised)
    pairs = [
        {"original_id": old, "revised_id": new},
        {"original_id": old, "revised_id": "revised-2"},
        {"original_id": "original-2", "revised_id": new},
        {"original_id": "original-3", "revised_id": "revised-3"},
    ]
    if reverse:
        pairs.reverse()
    monkeypatch.setattr(semantic, "_model_pairs", lambda *args: {"pairs": pairs})
    result = semantic.propose_semantic_matches(report)
    suggestions = [f for f in result.findings if f.match_method == "semantic_proposal"]
    assert len(suggestions) == 1
    assert suggestions[0].original.text.endswith("phase 3")
    assert suggestions[0].revised.text.endswith("phase 3")
    assert result.findings[:len(report.findings)] == report.findings


def test_valid_pairs_have_stable_ids_regardless_of_model_order(monkeypatch, unmatched_report):
    report = _expanded_unmatched(unmatched_report)
    pairs = [
        {"original_id": "original-2", "revised_id": "revised-2"},
        {"original_id": "original-3", "revised_id": "revised-3"},
    ]
    monkeypatch.setattr(semantic, "_model_pairs", lambda *args: {"pairs": pairs})
    first = semantic.propose_semantic_matches(report)
    pairs.reverse()
    second = semantic.propose_semantic_matches(report)
    assert first == second
    assert first.semantic_assistance == "proposals_added"
