"""Offline comparison CLI: privacy, replayability and no-clobber guarantees."""

import hashlib
import json
import os
import subprocess
import sys

import pytest

from noticebridge import compare_cli
from noticebridge.compare import compare_documents
from noticebridge.extract import extract_pdf
from noticebridge.isolation import ProcessingFailed, ProcessingTimedOut
from noticebridge.verify_report import _load_report, verify_saved_report


@pytest.fixture
def inputs(tmp_path, pdf_bytes):
    first = tmp_path / "original.pdf"
    second = tmp_path / "revised.pdf"
    first.write_bytes(pdf_bytes([["Application deadline: 13 December 2026"]]))
    second.write_bytes(pdf_bytes([["Application deadline: 19 December 2026"]]))
    return first, second


def _report_for_sources(original: bytes, revised: bytes):
    return compare_documents(
        extract_pdf(original, document_id="original", filename="original.pdf"),
        extract_pdf(revised, document_id="revised", filename="revised.pdf"),
    )


def test_offline_cli_produces_a_replayable_private_json_report(inputs, tmp_path):
    original, revised = inputs
    path = tmp_path / "review.json"
    summary = compare_cli.compare_to_file(original, revised, path)
    assert path.is_file()
    assert summary["total_findings"] == 1
    assert summary["status_counts"]["confirmed_change"] == 1
    assert summary["status_counts"]["possible_change"] == 0
    assert summary["status_counts"]["missing_information"] == 0
    assert summary["status_counts"]["contradiction"] == 0
    assert summary["review_tasks"] == 1
    assert summary["text_coverage"] == "all_pages_have_text"
    assert summary["semantic_assistance"] == "not_requested"
    assert summary["authority_verified"] is False
    assert summary["report_sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert summary["source_fingerprints"]["original"] == hashlib.sha256(
        original.read_bytes()
    ).hexdigest()
    assert summary["source_fingerprints"]["revised"] == hashlib.sha256(
        revised.read_bytes()
    ).hexdigest()
    assert "Application deadline" not in json.dumps(summary)
    saved = _load_report(path)
    verify_saved_report(saved, original.read_bytes(), revised.read_bytes())


def test_cli_argument_parser_produces_a_safe_terminal_summary(
    inputs, tmp_path, capsys,
):
    original, revised = inputs
    output = tmp_path / "comparison.json"
    assert compare_cli.main([str(original), str(revised), "--output", str(output)]) == 0
    captured = capsys.readouterr()
    assert "Saved private report:" in captured.out
    assert "Evidence is not issuer-authenticated" in captured.out
    assert captured.err == ""
    assert "Application deadline" not in captured.out
    assert output.is_file()


def test_machine_summary_does_not_echo_any_source_quote(
    inputs, tmp_path, capsys,
):
    original, revised = inputs
    out = tmp_path / "summary.json"
    assert compare_cli.main([
        str(original), str(revised), "--output", str(out), "--summary-json",
    ]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["format"] == "noticebridge-local-comparison-summary"
    assert result["total_findings"] == 1
    assert result["warning_count"] >= 0
    assert result["authority_verified"] is False
    assert set(result["source_fingerprints"]) == {"original", "revised"}
    assert "Application deadline" not in json.dumps(result)


def test_cli_subprocess_uses_disposable_worker_and_writes_no_source_quote(
    inputs, tmp_path,
):
    original, revised = inputs
    output = tmp_path / "result.json"
    run = subprocess.run(
        [
            sys.executable, "-m", "noticebridge.compare_cli",
            str(original), str(revised), "--output", str(output), "--summary-json",
        ],
        text=True, capture_output=True, timeout=35, check=False,
    )
    assert run.returncode == 0, run.stderr
    assert "Application deadline" not in run.stdout
    assert not run.stderr
    assert json.loads(run.stdout)["total_findings"] == 1
    assert _load_report(output).findings[0].status == "confirmed_change"


def test_refuses_to_overwrite_existing_report_before_worker_runs(
    inputs, tmp_path, monkeypatch,
):
    original, revised = inputs
    path = tmp_path / "existing.json"
    path.write_text("DO NOT REPLACE", encoding="utf-8")

    def no_worker(*args, **kwargs):
        pytest.fail("An existing destination must be rejected before PDF parsing")

    monkeypatch.setattr(compare_cli, "run_isolated_comparison", no_worker)
    with pytest.raises(compare_cli.CliError, match="already exists"):
        compare_cli.compare_to_file(original, revised, path)
    assert path.read_text(encoding="utf-8") == "DO NOT REPLACE"


def test_no_replace_on_repeat_invocation(inputs, tmp_path):
    original, revised = inputs
    target = tmp_path / "output.json"
    compare_cli.compare_to_file(original, revised, target)
    first_bytes = target.read_bytes()
    with pytest.raises(compare_cli.CliError, match="already exists"):
        compare_cli.compare_to_file(original, revised, target)
    assert target.read_bytes() == first_bytes


@pytest.mark.parametrize("invalid_target", [
    "report.pdf", "report.txt", "report.json/part.json",
])
def test_rejects_invalid_destination_and_missing_parent(
    inputs, tmp_path, invalid_target,
):
    original, revised = inputs
    invalid = tmp_path / invalid_target
    with pytest.raises(compare_cli.CliError):
        compare_cli.compare_to_file(original, revised, invalid)
    assert not invalid.exists()


@pytest.mark.parametrize(("label", "payload", "message"), [
    ("original", b"", "empty"),
    ("original", b"not a PDF", "recognized as a PDF"),
    ("revised", b"not a PDF", "recognized as a PDF"),
])
def test_invalid_source_bytes_never_generate_reports(
    inputs, tmp_path, label, payload, message,
):
    original, revised = inputs
    target = tmp_path / "should-not-exist.json"
    path = original if label == "original" else revised
    path.write_bytes(payload)
    with pytest.raises(compare_cli.CliError, match=message):
        compare_cli.compare_to_file(original, revised, target)
    assert not target.exists()
    assert not list(tmp_path.glob(".noticebridge-*.tmp"))


@pytest.mark.parametrize("role", ["original", "revised"])
def test_missing_sources_never_generate_reports(inputs, tmp_path, role):
    original, revised = inputs
    target = tmp_path / "report.json"
    if role == "original":
        original.unlink()
    else:
        revised.unlink()
    with pytest.raises(compare_cli.CliError, match=f"read the {role}"):
        compare_cli.compare_to_file(original, revised, target)
    assert not target.exists()


@pytest.mark.parametrize("role", ["original", "revised"])
def test_pdf_extension_is_required(inputs, tmp_path, role):
    original, revised = inputs
    path = original if role == "original" else revised
    changed = path.with_suffix(".txt")
    path.rename(changed)
    target = tmp_path / "report.json"
    with pytest.raises(compare_cli.CliError, match=r"\.pdf filename"):
        if role == "original":
            compare_cli.compare_to_file(changed, revised, target)
        else:
            compare_cli.compare_to_file(original, changed, target)
    assert not target.exists()


def test_overlarge_input_is_rejected_before_worker_runs(
    inputs, tmp_path, monkeypatch,
):
    original, revised = inputs
    monkeypatch.setattr(compare_cli, "MAX_UPLOAD_BYTES", 16)
    target = tmp_path / "report.json"

    def no_worker(*args, **kwargs):
        pytest.fail("Oversized PDF must not be submitted to the worker")

    monkeypatch.setattr(compare_cli, "run_isolated_comparison", no_worker)
    with pytest.raises(compare_cli.CliError, match="exceeds 10 MiB"):
        compare_cli.compare_to_file(original, revised, target)
    assert not target.exists()


def test_ocr_flags_are_opt_in_and_page_selection_is_bounded(
    inputs, tmp_path, monkeypatch,
):
    original, revised = inputs
    recorded = []
    report = _report_for_sources(original.read_bytes(), revised.read_bytes())

    def fake_worker(*sources, **options):
        assert sources == (original.read_bytes(), revised.read_bytes())
        recorded.append(options)
        return report

    monkeypatch.setattr(compare_cli, "run_isolated_comparison", fake_worker)
    compare_cli.compare_to_file(original, revised, tmp_path / "plain.json")
    compare_cli.compare_to_file(
        original, revised, tmp_path / "selected.json",
        automatic_ocr=True, original_ocr_pages="1,3-4",
        revised_ocr_pages="2,4",
    )
    assert recorded[0]["enable_semantic"] is False
    assert recorded[0]["enable_ocr"] is False
    assert recorded[0]["original_ocr_pages"] == ()
    assert recorded[0]["revised_ocr_pages"] == ()
    assert recorded[1]["enable_semantic"] is False
    assert recorded[1]["enable_ocr"] is True
    assert recorded[1]["original_ocr_pages"] == (1, 3, 4)
    assert recorded[1]["revised_ocr_pages"] == (2, 4)


@pytest.mark.parametrize("pages", ["0", "999", "2-1", "1,invalid", "1-80"])
def test_invalid_ocr_page_selection_fails_before_worker(
    inputs, tmp_path, monkeypatch, pages,
):
    original, revised = inputs
    monkeypatch.setattr(
        compare_cli, "run_isolated_comparison",
        lambda *args, **kwargs: pytest.fail("Invalid page selection reached worker"),
    )
    target = tmp_path / "rejected.json"
    with pytest.raises(compare_cli.CliError):
        compare_cli.compare_to_file(
            original, revised, target, original_ocr_pages=pages,
        )
    assert not target.exists()


def test_semantic_proposals_cannot_be_silently_exported(
    inputs, tmp_path, monkeypatch,
):
    original, revised = inputs
    report = _report_for_sources(original.read_bytes(), revised.read_bytes())
    report.semantic_assistance = "proposals_added"
    monkeypatch.setattr(compare_cli, "run_isolated_comparison", lambda *a, **k: report)
    target = tmp_path / "report.json"
    with pytest.raises(compare_cli.CliError, match="unexpected AI proposal"):
        compare_cli.compare_to_file(original, revised, target)
    assert not target.exists()


@pytest.mark.parametrize(("exception", "message"), [
    (ProcessingFailed("secret PDF content from parser"), "worker failed"),
    (ProcessingTimedOut("secret PDF content from parser"), "deadline"),
])
def test_worker_errors_are_sanitized_and_never_save_a_report(
    inputs, tmp_path, monkeypatch, capsys, exception, message,
):
    original, revised = inputs

    def fail(*args, **kwargs):
        raise exception

    monkeypatch.setattr(compare_cli, "run_isolated_comparison", fail)
    output = tmp_path / "report.json"
    assert compare_cli.main([
        str(original), str(revised), "--output", str(output),
    ]) == 1
    captured = capsys.readouterr()
    assert message in captured.err
    assert "secret PDF content" not in captured.err
    assert captured.out == ""
    assert not output.exists()


def test_atomic_destination_race_preserves_new_owner_file(
    inputs, tmp_path, monkeypatch,
):
    destination = tmp_path / "report.json"
    original_link = compare_cli.os.link

    def racing_link(source, target):
        destination.write_bytes(b"OTHER PROCESS CONTENT")
        return original_link(source, target)

    monkeypatch.setattr(compare_cli.os, "link", racing_link)
    with pytest.raises(compare_cli.CliError, match="already exists"):
        compare_cli._publish_report(destination, b"PRIVATE EVIDENCE")
    assert destination.read_bytes() == b"OTHER PROCESS CONTENT"
    assert not list(tmp_path.glob(".noticebridge-*.tmp"))


def test_failed_atomic_link_cleans_up_temporary_data(tmp_path, monkeypatch):
    destination = tmp_path / "report.json"

    def unavailable_link(*args):
        raise OSError("hard links unsupported")

    monkeypatch.setattr(compare_cli.os, "link", unavailable_link)
    with pytest.raises(compare_cli.CliError, match="atomic private evidence"):
        compare_cli._publish_report(destination, b"SENSITIVE CONTENT")
    assert not destination.exists()
    assert not list(tmp_path.glob(".noticebridge-*.tmp"))


def test_empty_or_oversized_generated_report_is_refused(
    tmp_path, monkeypatch,
):
    monkeypatch.setattr(compare_cli, "MAX_REPORT_BYTES", 8)
    destination = tmp_path / "report.json"
    for value in (b"", b"9" * 9):
        with pytest.raises(compare_cli.CliError, match="safety limit"):
            compare_cli._publish_report(destination, value)
    assert not destination.exists()
    assert not list(tmp_path.glob(".noticebridge-*.tmp"))


@pytest.mark.skipif(os.name == "nt", reason="POSIX private temp-file permissions")
def test_published_json_is_owner_readable_only(tmp_path):
    target = tmp_path / "private.json"
    compare_cli._publish_report(target, b'{"example":true}')
    assert target.stat().st_mode & 0o777 == 0o600


def test_cli_help_mentions_local_only_and_no_authority(capsys):
    with pytest.raises(SystemExit) as exc:
        compare_cli.main(["--help"])
    assert exc.value.code == 0
    result = capsys.readouterr().out
    # argparse may wrap the description at different console widths.
    assert "without network uploads" in " ".join(result.split())
    assert "--output" in result
    assert "--automatic-ocr" in result
    assert "--summary-json" in result


def test_cli_no_output_argument_rejected(capsys, inputs):
    original, revised = inputs
    with pytest.raises(SystemExit) as exc:
        compare_cli.main([str(original), str(revised)])
    assert exc.value.code == 2
    assert "required" in capsys.readouterr().err


def test_role_filenames_are_display_metadata_not_authority(
    inputs, tmp_path, monkeypatch,
):
    original, revised = inputs
    renamed = original.with_name("odd-name.pdf")
    original.rename(renamed)
    report = _report_for_sources(renamed.read_bytes(), revised.read_bytes())
    called = []

    def fake_worker(*sources, **kwargs):
        called.append(kwargs)
        return report

    monkeypatch.setattr(compare_cli, "run_isolated_comparison", fake_worker)
    compare_cli.compare_to_file(renamed, revised, tmp_path / "out.json")
    assert called[0]["old_name"] == "odd-name.pdf"
    assert called[0]["new_name"] == "revised.pdf"
    assert "authority_verified" in json.loads(
        (tmp_path / "out.json").read_text(encoding="utf-8")
    )["findings"][0]


def test_cli_never_creates_output_parent_directories(inputs, tmp_path):
    original, revised = inputs
    destination = tmp_path / "not-created" / "report.json"
    with pytest.raises(compare_cli.CliError, match="parent directory"):
        compare_cli.compare_to_file(original, revised, destination)
    assert not destination.parent.exists()


def test_atomic_export_is_verifiable_with_saved_report_loader(inputs, tmp_path):
    original, revised = inputs
    output = tmp_path / "private.json"
    compare_cli.compare_to_file(original, revised, output)
    report = _load_report(output)
    assert report.documents[0].sha256 == hashlib.sha256(original.read_bytes()).hexdigest()
    assert report.documents[1].sha256 == hashlib.sha256(revised.read_bytes()).hexdigest()
    assert all(not finding.authority_verified for finding in report.findings)
