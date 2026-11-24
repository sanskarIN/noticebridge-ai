"""Exercise local report replay, including the actual CLI and isolated worker."""

import json
import subprocess
import sys

import pytest

from noticebridge import extract, verify_report
from noticebridge.compare import compare_documents
from noticebridge.extract import extract_pdf
from noticebridge.provenance import InvalidReportProvenance
from noticebridge.verify_report import ReplayError, verify_saved_report


@pytest.fixture
def sources(pdf_bytes):
    original = pdf_bytes([["Application deadline: 19 December 2026"]])
    revised = pdf_bytes([["Application deadline: 13 December 2026"]])
    return original, revised


def _compare(original, revised, *, old_ocr_pages=()):
    return compare_documents(
        extract_pdf(
            original, document_id="original", filename="uploaded-original.pdf",
            ocr_override_pages=old_ocr_pages,
        ),
        extract_pdf(revised, document_id="revised", filename="uploaded-revised.pdf"),
    )


def test_cli_replays_browser_export_with_renamed_local_source_files(tmp_path, sources):
    original, revised = sources
    report = _compare(original, revised)
    evidence_file = tmp_path / "evidence.json"
    evidence_file.write_text(json.dumps({
        **report.model_dump(mode="json", exclude={"automatic_ocr"}),
        "review": ["f1"],
        "comparison_source": "live_upload",
        "exported_at": "2026-11-23T10:00:00.000Z",
    }, indent=2), encoding="utf-8")
    old_path = tmp_path / "renamed original.pdf"
    new_path = tmp_path / "renamed revised.pdf"
    old_path.write_bytes(original)
    new_path.write_bytes(revised)

    result = subprocess.run(
        [sys.executable, "-m", "noticebridge.verify_report", evidence_file, old_path, new_path],
        capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "Verified both SHA-256 fingerprints and reproduced 1 finding(s)." in result.stdout
    assert "Application deadline" not in result.stdout


def test_hash_mismatch_fails_before_pdf_replay(sources, monkeypatch):
    original, revised = sources
    report = _compare(original, revised)
    monkeypatch.setattr(
        verify_report, "run_isolated_comparison",
        lambda *args, **kwargs: pytest.fail("mismatched file reached the PDF worker"),
    )
    with pytest.raises(InvalidReportProvenance, match="original document fingerprint"):
        verify_saved_report(report, revised, original)


def test_report_with_omitted_findings_fails_exact_replay(sources):
    original, revised = sources
    report = _compare(original, revised)
    report.findings.clear()
    report.checklist.clear()
    with pytest.raises(ReplayError, match="saved evidence differs from the replay"):
        verify_saved_report(report, original, revised)


def test_replay_checks_evidence_coordinates_against_fresh_extraction(sources):
    original, revised = sources
    report = _compare(original, revised)
    evidence = report.findings[0].original
    assert evidence is not None
    x0, y0, x1, y1 = evidence.bbox
    evidence.bbox = (x0, y0 + 1, x1, y1 + 1)
    with pytest.raises(ReplayError, match="saved evidence differs from the replay"):
        verify_saved_report(report, original, revised)


def test_selected_page_ocr_must_be_requested_and_is_replayed_from_saved_page_numbers(
    sources, monkeypatch,
):
    original, revised = sources
    monkeypatch.setattr(extract, "_extract_ocr_dict", lambda page: page.get_text("dict"))
    report = _compare(original, revised, old_ocr_pages=(1,))
    calls = []

    def replay(*args, **kwargs):
        calls.append(kwargs)
        return report.model_copy(update={"automatic_ocr": kwargs["enable_ocr"]})

    monkeypatch.setattr(verify_report, "run_isolated_comparison", replay)
    with pytest.raises(ReplayError, match="This report used OCR"):
        verify_saved_report(report, original, revised)
    assert calls == []
    verify_saved_report(report, original, revised, ocr="selected")
    assert len(calls) == 1
    assert calls[0]["enable_ocr"] is False
    assert calls[0]["original_ocr_pages"] == (1,)
    assert calls[0]["revised_ocr_pages"] == ()
    calls.clear()
    verify_saved_report(report.model_copy(update={"automatic_ocr": False}), original, revised)
    assert [call["original_ocr_pages"] for call in calls] == [(1,)]


def test_cli_replays_automatic_ocr_even_when_no_page_yielded_ocr_text(pdf_bytes, tmp_path):
    original = pdf_bytes([["Application deadline: 19 December 2026"], []])
    revised = pdf_bytes([["Application deadline: 13 December 2026"]])
    report = verify_report.run_isolated_comparison(
        original, revised, old_name="original.pdf", new_name="revised.pdf", enable_ocr=True,
    )
    assert report.automatic_ocr is True
    assert report.documents[0].ocr_pages == []
    assert report.documents[0].pages_without_text == [2]
    saved = tmp_path / "automatic-ocr.json"
    old_path = tmp_path / "original.pdf"
    new_path = tmp_path / "revised.pdf"
    saved.write_text(report.model_dump_json(), encoding="utf-8")
    old_path.write_bytes(original)
    new_path.write_bytes(revised)
    assert verify_report.main([str(saved), str(old_path), str(new_path)]) == 0

    with pytest.raises(InvalidReportProvenance, match="Recorded automatic OCR mode differs"):
        verify_saved_report(report, original, revised, ocr="off")
    legacy = report.model_copy(update={"automatic_ocr": None})
    verify_saved_report(legacy, original, revised, ocr="automatic")


def test_saved_ocr_metadata_requires_a_json_boolean(sources, tmp_path, capsys):
    saved = tmp_path / "report.json"
    payload = _compare(*sources).model_dump(mode="json")
    payload["automatic_ocr"] = "true"
    saved.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(SystemExit) as result:
        verify_report.main([str(saved), "unused-original.pdf", "unused-revised.pdf"])
    assert result.value.code == 1
    assert "does not contain a valid evidence report" in capsys.readouterr().err


def test_replay_requires_experimental_ai_to_be_disabled(sources, monkeypatch):
    original, revised = sources
    report = _compare(original, revised)
    report.semantic_assistance = "no_candidates"
    monkeypatch.setattr(
        verify_report, "run_isolated_comparison",
        lambda *args, **kwargs: pytest.fail("experimental AI report reached the PDF worker"),
    )
    with pytest.raises(ReplayError, match="experimental AI suggestions disabled"):
        verify_saved_report(report, original, revised)


@pytest.mark.parametrize(("raw", "error"), [
    ('{"documents": [], "documents": []}', "duplicate JSON field"),
    ('{"documents": [], "auxiliary": NaN}', "non-finite JSON number"),
    ('{"documents":', "not valid JSON"),
    ('{"documents": []}', "does not contain a valid evidence report"),
])
def test_cli_rejects_invalid_saved_reports_without_echoing_the_payload(
    tmp_path, capsys, raw, error,
):
    saved = tmp_path / "report.json"
    saved.write_text(raw, encoding="utf-8")
    with pytest.raises(SystemExit) as result:
        verify_report.main([str(saved), "unused.pdf", "unused.pdf"])
    assert result.value.code == 1
    assert error in capsys.readouterr().err


@pytest.mark.parametrize("mutation", [
    "numeric_string", "boolean_page", "float_page", "string_boolean",
    "extra_nested", "extra_root", "missing_authority", "missing_coverage",
    "missing_evidence", "missing_checklist", "string_similarity",
])
def test_replay_loader_rejects_silent_schema_normalization(sources, tmp_path, mutation):
    payload = _compare(*sources).model_dump(mode="json")
    finding = payload["findings"][0]
    evidence = finding["original"]
    if mutation == "numeric_string":
        evidence["page"] = "1"
    elif mutation == "boolean_page":
        evidence["page"] = True
    elif mutation == "float_page":
        evidence["page"] = 1.0
    elif mutation == "string_boolean":
        finding["authority_verified"] = "false"
    elif mutation == "extra_nested":
        evidence["issuer_verified"] = True
    elif mutation == "extra_root":
        payload["officially_verified"] = True
    elif mutation == "missing_authority":
        del finding["authority_verified"]
    elif mutation == "missing_coverage":
        del payload["documents"][0]["pages_without_text"]
    elif mutation == "missing_evidence":
        del evidence["extraction_method"]
    elif mutation == "missing_checklist":
        del payload["checklist"]
    else:
        finding["similarity"] = str(finding["similarity"])

    saved = tmp_path / "modified.json"
    saved.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ReplayError, match="does not contain a valid evidence report"):
        verify_report._load_report(saved)


def test_loader_accepts_integral_json_numbers_in_float_fields(sources, tmp_path):
    report = _compare(*sources)
    payload = report.model_dump(mode="json")

    def browser_numbers(value):
        if isinstance(value, dict):
            return {key: browser_numbers(item) for key, item in value.items()}
        if isinstance(value, list):
            return [browser_numbers(item) for item in value]
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return value

    saved = tmp_path / "browser.json"
    saved.write_text(json.dumps(browser_numbers(payload)), encoding="utf-8")
    assert verify_report._load_report(saved) == report


def test_loader_rejects_overflowing_json_float(sources, tmp_path):
    payload = _compare(*sources).model_dump(mode="json")
    saved = tmp_path / "overflow.json"
    data = json.dumps(payload)
    saved.write_text(data[:-1] + ', "review": [1e9999]}', encoding="utf-8")
    with pytest.raises(ReplayError, match="non-finite JSON number"):
        verify_report._load_report(saved)
