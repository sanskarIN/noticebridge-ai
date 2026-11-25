"""Check generated fictional PDFs and the production batch interoperability fixture."""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pymupdf as fitz
import pytest

from noticebridge.batch_cli import BatchError, load_manifest, verify_batch

BENCHMARKS = Path(__file__).resolve().parents[1] / "benchmarks"
sys.path.insert(0, str(BENCHMARKS))
from generate_batch_fixture import EXAMPLES, generate_batch_fixture, generate_sources  # noqa: E402


@pytest.fixture(scope="module")
def demo(tmp_path_factory):
    output = tmp_path_factory.mktemp("batch-demo") / "fictional"
    result = generate_batch_fixture(output, replay=True)
    return output, result


def test_sources_are_explicitly_fictional_and_ordered(tmp_path):
    output = tmp_path / "source-only"
    plan = generate_sources(output)
    payload = json.loads(plan.read_bytes())
    assert payload["version"] == 1
    assert len(payload["cases"]) == len(EXAMPLES) == 3
    for number, pair in enumerate(payload["cases"], 1):
        assert pair == {
            "original": f"case-{number:03d}-original.pdf",
            "revised": f"case-{number:03d}-revised.pdf",
        }
        for role in ("original", "revised"):
            with fitz.open(output / pair[role]) as document:
                first = document[0].get_text()
                assert "FICTIONAL NOTICE" in first
                assert EXAMPLES[number - 1].title in first
                assert len(document) == (2 if number == 2 and role == "revised" else 1)


def test_blank_revised_page_is_actually_empty(tmp_path):
    output = tmp_path / "source-only"
    generate_sources(output)
    with fitz.open(output / "case-002-revised.pdf") as document:
        assert len(document) == 2
        assert not document[1].get_text().strip()


def test_existing_directory_is_never_overwritten(tmp_path):
    output = tmp_path / "existing"
    output.mkdir()
    sentinel = output / "manifest.json"
    sentinel.write_bytes(b"do not replace")
    with pytest.raises(BatchError):
        generate_sources(output)
    assert sentinel.read_bytes() == b"do not replace"
    assert sorted(path.name for path in output.iterdir()) == ["manifest.json"]


def test_demo_uses_real_engine_and_replay(demo):
    output, summary = demo
    index = json.loads((output / "batch" / "index.json").read_bytes())
    assert summary["case_count"] == summary["completed_count"] == 3
    assert summary["synthetic"] is True
    assert summary["engine_replayed"] is True
    assert summary["authority_verified"] is False
    assert index["complete"] is True
    assert index["status_counts"] == summary["status_counts"]
    assert index["manifest_sha256"] == summary["manifest_sha256"]
    assert hashlib.sha256((output / "manifest.json").read_bytes()).hexdigest() == (
        summary["manifest_sha256"]
    )


def test_manifest_pins_every_generated_pdf(demo):
    output, _ = demo
    manifest = load_manifest(output / "manifest.json")
    assert len(manifest.cases) == 3
    for case in manifest.cases:
        assert hashlib.sha256(case.original.read_bytes()).hexdigest() == case.original_sha256
        assert hashlib.sha256(case.revised.read_bytes()).hexdigest() == case.revised_sha256


def test_changed_deadline_and_fee_have_real_source_evidence(demo):
    output, _ = demo
    report = json.loads((output / "batch" / "case-001.json").read_bytes())
    changed = [item for item in report["findings"] if item["status"] == "confirmed_change"]
    assert {"deadline", "fee"} <= {item["category"] for item in changed}
    assert all(item["original"] and item["revised"] for item in changed)
    assert all(item["authority_verified"] is False for item in changed)


def test_partial_case_preserves_uncovered_page_metadata(demo):
    output, _ = demo
    report = json.loads((output / "batch" / "case-002.json").read_bytes())
    assert report["text_coverage"] == "partial"
    assert report["documents"][1]["pages_without_text"] == [2]
    assert report["automatic_ocr"] is False
    assert report["semantic_assistance"] == "not_requested"


def test_contradiction_has_two_same_page_source_quotes(demo):
    output, _ = demo
    report = json.loads((output / "batch" / "case-003.json").read_bytes())
    conflicts = [item for item in report["findings"] if item["status"] == "contradiction"]
    assert conflicts
    for item in conflicts:
        assert item["authority_verified"] is False
        evidence = item["supporting_evidence"]
        assert len(evidence) == 2
        assert evidence[0]["page"] == evidence[1]["page"]
        assert evidence[0]["document_id"] == evidence[1]["document_id"] == "revised"


def test_generated_fixture_can_be_replayed_independently(demo):
    output, _ = demo
    result = verify_batch(output / "manifest.json", output / "batch")
    assert result["complete"] is True
    assert result["completed_count"] == 3
    for row in result["cases"]:
        report = output / "batch" / row["report"]
        assert hashlib.sha256(report.read_bytes()).hexdigest() == row["report_sha256"]


def test_cli_failure_does_not_echo_user_path(tmp_path):
    directory = tmp_path / "private-directory-name"
    directory.mkdir()
    run = subprocess.run(
        [sys.executable, str(BENCHMARKS / "generate_batch_fixture.py"),
         "--output", str(directory)],
        capture_output=True, text=True, check=False, timeout=30,
    )
    assert run.returncode == 1
    assert not run.stdout
    assert "private-directory-name" not in run.stderr
