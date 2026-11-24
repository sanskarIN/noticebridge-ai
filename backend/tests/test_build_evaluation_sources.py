"""Exercise corpus acquisition without downloads, OCR, model calls or human-label claims."""

import json
import sys
from pathlib import Path

import pytest

BENCHMARKS = Path(__file__).resolve().parents[1] / "benchmarks"
sys.path.insert(0, str(BENCHMARKS))
from audit_evaluation_split import audit_split  # noqa: E402
from build_evaluation_sources import build_sources, main  # noqa: E402
from evaluate_labeled import _manifest, _require_ready_for_scoring  # noqa: E402
from pin_labeled_dataset import pin_dataset  # noqa: E402
from prepare_independent_review import check_review, prepare_review  # noqa: E402


def _write(path, payload):
    path.write_text(json.dumps(payload), encoding="utf-8")


@pytest.fixture
def register(tmp_path, pdf_bytes):
    for name, quote in (("old", "Fictional old text"), ("new", "Fictional new text")):
        (tmp_path / f"{name}.pdf").write_bytes(pdf_bytes([[quote]]))
    path = tmp_path / "register.json"
    _write(path, {"version": 1, "cases": [{
        "id": "sample", "source_kind": "fictional", "issuer_group": "board",
        "event_group": "event", "original": "old.pdf", "revised": "new.pdf",
    }]})
    return path


def test_intake_cannot_be_scored_even_with_completion_flag(register):
    output = register.with_name("source.json")
    report = build_sources(register, output=output)
    assert report["case_count"] == 1
    assert report["distinct_document_count"] == 2
    assert not report["review_complete"]
    version, cases, _ = _manifest(output)
    assert version == 2
    case = cases[0]
    assert case["label_method"] == "unreviewed"
    assert case["expected_pairs"] == []
    for complete in (False, True):
        case["review_complete"] = complete
        with pytest.raises(ValueError, match="unfinished review"):
            _require_ready_for_scoring(cases)
    before = output.read_bytes()
    with pytest.raises(FileExistsError):
        build_sources(register, output=output)
    assert output.read_bytes() == before


@pytest.mark.parametrize("change", [
    {"expected_pairs": []}, {"label_method": "independent_human"},
    {"issuer_group": "bad group"}, {"event_group": None},
    {"source_kind": "unknown"}, {"original": "../old.pdf"},
    {"original_ocr_pages": [0]},
])
def test_intake_rejects_unapproved_or_invalid_metadata(register, change):
    payload = json.loads(register.read_bytes())
    payload["cases"][0].update(change)
    _write(register, payload)
    target = register.with_name("source.json")
    with pytest.raises(ValueError):
        build_sources(register, output=target)
    assert not target.exists()


def test_reversed_duplicate_pair_and_non_pdf_header_rejected(register):
    payload = json.loads(register.read_bytes())
    case = payload["cases"][0]
    payload["cases"].append({
        **case, "id": "reversed", "original": case["revised"], "revised": case["original"],
    })
    _write(register, payload)
    target = register.with_name("source.json")
    with pytest.raises(ValueError, match="repeated unordered"):
        build_sources(register, output=target)
    assert not target.exists()
    payload["cases"].pop()
    _write(register, payload)
    (register.parent / "new.pdf").write_bytes(b"not a PDF")
    with pytest.raises(ValueError, match="PDF signature"):
        build_sources(register, output=target)


def test_group_metadata_survives_blind_review_and_cannot_be_changed(register):
    source = register.with_name("source.json")
    review = register.with_name("review.json")
    build_sources(register, output=source)
    prepare_review(source, output=review)
    payload = json.loads(review.read_bytes())
    case = payload["cases"][0]
    assert case["issuer_group"] == "board"
    assert case["event_group"] == "event"
    case["review_complete"] = True
    _write(review, payload)
    assert check_review(source, review=review)["completed_case_count"] == 1
    case["event_group"] = "different"
    _write(review, payload)
    with pytest.raises(ValueError, match="disagree"):
        check_review(source, review=review)


def test_event_group_overlap_fails_without_any_byte_overlap(register, pdf_bytes):
    source = register.with_name("source.json")
    build_sources(register, output=source)
    payload = json.loads(register.read_bytes())
    case = payload["cases"][0]
    for role in ("original", "revised"):
        name = f"different-{role}.pdf"
        (register.parent / name).write_bytes(pdf_bytes([[name]]))
        case[role] = name
    case.update(id="different", issuer_group="BOARD", event_group="EVENT")
    _write(register, payload)
    test = register.with_name("heldout.json")
    build_sources(register, output=test)
    report = audit_split(source, test, require_event_groups=True)
    assert report["shared_document_count"] == 0
    assert report["shared_declared_event_group_count"] == 1
    assert not report["passed"]
    heldout = json.loads(test.read_bytes())
    heldout["cases"][0]["event_group"] = "unrelated"
    _write(test, heldout)
    assert audit_split(source, test, require_event_groups=True)["passed"]
    del heldout["cases"][0]["event_group"]
    del heldout["cases"][0]["issuer_group"]
    _write(test, heldout)
    assert audit_split(source, test)["passed"]
    assert not audit_split(source, test, require_event_groups=True)["passed"]


def test_cli_reports_counts_not_quotes(register, capsys):
    target = register.with_name("source.json")
    assert main([str(register), "--output", str(target)]) == 0
    raw = capsys.readouterr().out
    assert json.loads(raw)["declared_event_group_count"] == 1
    assert "Fictional old text" not in raw


def test_legacy_label_pinning_is_not_a_source_intake_shortcut(register):
    path = register.with_name("source-v1.json")
    _write(path, {"version": 1, "cases": [{
        "id": "sample", "original": "old.pdf", "revised": "new.pdf", "expected_pairs": [],
    }]})
    output = register.with_name("source.json")
    with pytest.raises(ValueError, match="label method"):
        pin_dataset(path, output=output, source_kind="fictional", label_method="unreviewed")
    assert not output.exists()


def test_intake_does_not_accept_extra_top_level_annotations(register):
    payload = json.loads(register.read_bytes())
    payload["label_review"] = {"completed": True}
    _write(register, payload)
    with pytest.raises(ValueError, match="Source register"):
        build_sources(register, output=register.with_name("source.json"))


def test_group_fields_must_appear_together_in_pinned_manifests(register):
    source = register.with_name("source.json")
    build_sources(register, output=source)
    payload = json.loads(source.read_bytes())
    del payload["cases"][0]["event_group"]
    _write(source, payload)
    with pytest.raises(ValueError, match="must occur together"):
        _manifest(source)
