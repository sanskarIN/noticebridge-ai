"""Native-text batch workflow: strict manifest, bounded output and replay."""

import hashlib
import json

import pytest

from noticebridge import batch_cli
from noticebridge.compare import compare_documents
from noticebridge.extract import extract_pdf
from noticebridge.isolation import ProcessingTimedOut


def _hash(data):
    return hashlib.sha256(data).hexdigest()


def _write(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


@pytest.fixture
def manifest(tmp_path, pdf_bytes):
    cases = []
    for number in range(2):
        old = pdf_bytes([[f"Application deadline: {10 + number} December 2026"]])
        new = pdf_bytes([[f"Application deadline: {20 + number} December 2026"]])
        old_name = f"private-original-{number}.pdf"
        new_name = f"private-revised-{number}.pdf"
        (tmp_path / old_name).write_bytes(old)
        (tmp_path / new_name).write_bytes(new)
        cases.append({
            "original": old_name, "revised": new_name,
            "original_sha256": _hash(old), "revised_sha256": _hash(new),
        })
    return _write(tmp_path / "manifest.json", {"version": 1, "cases": cases})


@pytest.fixture
def fast_worker(monkeypatch):
    """Use the real extraction/comparison engine without subprocess startup."""
    def run(original, revised, *, old_name, new_name, enable_ocr=False,
            enable_semantic=False, **kwargs):
        assert not enable_ocr
        assert not enable_semantic
        result = compare_documents(
            extract_pdf(original, document_id="original", filename=old_name),
            extract_pdf(revised, document_id="revised", filename=new_name),
        )
        return result.model_copy(update={"automatic_ocr": False})

    monkeypatch.setattr(batch_cli, "run_isolated_comparison", run)
    import noticebridge.verify_report as replay
    monkeypatch.setattr(replay, "run_isolated_comparison", run)


def _mutate(manifest, change):
    value = json.loads(manifest.read_text(encoding="utf-8"))
    change(value)
    _write(manifest, value)


def test_manifest_pins_order_and_exact_bytes(manifest):
    result = batch_cli.load_manifest(manifest)
    assert len(result.cases) == 2
    assert result.sha256 == _hash(manifest.read_bytes())
    assert result.cases[0].original.name == "private-original-0.pdf"
    assert result.cases[1].revised.name == "private-revised-1.pdf"


@pytest.mark.parametrize("version", [True, False, 0, 2, "1", None])
def test_version_is_strict(manifest, version):
    _mutate(manifest, lambda raw: raw.update(version=version))
    with pytest.raises(batch_cli.BatchError):
        batch_cli.load_manifest(manifest)


@pytest.mark.parametrize("value", [None, {}, [], "case", 1])
def test_cases_must_be_nonempty_list(manifest, value):
    _mutate(manifest, lambda raw: raw.update(cases=value))
    with pytest.raises(batch_cli.BatchError):
        batch_cli.load_manifest(manifest)


@pytest.mark.parametrize("key", ["original", "revised", "original_sha256", "revised_sha256"])
def test_missing_case_field_rejected(manifest, key):
    _mutate(manifest, lambda raw: raw["cases"][0].pop(key))
    with pytest.raises(batch_cli.BatchError):
        batch_cli.load_manifest(manifest)


def test_unknown_fields_rejected(manifest):
    _mutate(manifest, lambda raw: raw["cases"][0].update(enable_semantic=True))
    with pytest.raises(batch_cli.BatchError):
        batch_cli.load_manifest(manifest)


@pytest.mark.parametrize("bad", [
    "../outside.pdf", "/tmp/private.pdf", "C:private.pdf",
    "C:/private.pdf", "folder\\private.pdf", "./private.pdf",
    "folder//private.pdf", "folder/../private.pdf", "private.txt",
    "", "file\x00.pdf", 42, None, "a" * 241 + ".pdf",
])
def test_invalid_source_paths(manifest, bad):
    _mutate(manifest, lambda raw: raw["cases"][0].update(original=bad))
    with pytest.raises(batch_cli.BatchError):
        batch_cli.load_manifest(manifest)


@pytest.mark.parametrize("bad", ["a" * 63, "a" * 65, "A" * 64, "z" * 64, 123, None])
def test_invalid_hashes(manifest, bad):
    _mutate(manifest, lambda raw: raw["cases"][0].update(original_sha256=bad))
    with pytest.raises(batch_cli.BatchError):
        batch_cli.load_manifest(manifest)


def test_duplicate_pair_rejected(manifest):
    _mutate(manifest, lambda raw: raw["cases"].append(raw["cases"][0]))
    with pytest.raises(batch_cli.BatchError, match="Duplicate pinned"):
        batch_cli.load_manifest(manifest)


def test_case_limit_rejected_before_source_resolution(manifest):
    _mutate(manifest, lambda raw: raw.update(cases=raw["cases"] * 9))
    with pytest.raises(batch_cli.BatchError, match="between 1 and 16"):
        batch_cli.load_manifest(manifest)


@pytest.mark.parametrize("payload", [
    b'{"version":1,"version":1,"cases":[]}',
    b'{"version":NaN,"cases":[]}',
    b'{"version":Infinity,"cases":[]}',
    b'{"version":1,"cases":[{"original":"a","original":"b"}]}',
    b'[]', b'null', b'{', b'\xff',
])
def test_malformed_or_ambiguous_json(manifest, payload):
    manifest.write_bytes(payload)
    with pytest.raises(batch_cli.BatchError):
        batch_cli.load_manifest(manifest)


def test_manifest_size_limit(manifest):
    manifest.write_bytes(b" " * (batch_cli.MAX_MANIFEST_BYTES + 1))
    with pytest.raises(batch_cli.BatchError, match="size limit"):
        batch_cli.load_manifest(manifest)


def test_source_symlink_outside_root_rejected(manifest, tmp_path):
    target = tmp_path.parent / (tmp_path.name + "-outside.pdf")
    target.write_bytes(b"%PDF-example")
    alias = tmp_path / "alias.pdf"
    try:
        try:
            alias.symlink_to(target)
        except OSError:
            pytest.skip("Symlinks unavailable on this platform")
        _mutate(manifest, lambda raw: raw["cases"][0].update(original="alias.pdf"))
        with pytest.raises(batch_cli.BatchError, match="inside"):
            batch_cli.load_manifest(manifest)
    finally:
        target.unlink(missing_ok=True)


def test_complete_batch_and_replay(manifest, tmp_path, fast_worker):
    output = tmp_path / "batch"
    index = batch_cli.run_batch(manifest, output)
    assert index["complete"] is True
    assert index["case_count"] == index["completed_count"] == 2
    assert index["authority_verified"] is False
    assert index["status_counts"]["confirmed_change"] == 2
    assert sorted(p.name for p in output.iterdir()) == [
        "case-001.json", "case-002.json", "index.json",
    ]
    for row in index["cases"]:
        assert row["report_sha256"] == _hash((output / row["report"]).read_bytes())
    assert batch_cli.verify_batch(manifest, output) == index
    stored = (output / "index.json").read_text(encoding="utf-8")
    assert "Application deadline" not in stored
    assert "private-original" not in stored


def test_live_worker_batch_and_replay(manifest, tmp_path):
    # One genuine subprocess round trip on the production execution path.
    _mutate(manifest, lambda raw: raw["cases"].pop())
    output = tmp_path / "live"
    index = batch_cli.run_batch(manifest, output)
    assert index["complete"] is True
    assert batch_cli.verify_batch(manifest, output) == index


def test_existing_directory_is_not_reused(manifest, tmp_path, fast_worker):
    output = tmp_path / "existing"
    output.mkdir()
    sentinel = output / "index.json"
    sentinel.write_text("preserve", encoding="utf-8")
    with pytest.raises(batch_cli.BatchError, match="new directory"):
        batch_cli.run_batch(manifest, output)
    assert sentinel.read_text(encoding="utf-8") == "preserve"


def test_bad_manifest_does_not_create_output(manifest, tmp_path):
    manifest.write_text("{}", encoding="utf-8")
    output = tmp_path / "absent"
    with pytest.raises(batch_cli.BatchError):
        batch_cli.run_batch(manifest, output)
    assert not output.exists()


def test_changed_source_stops_before_worker(manifest, tmp_path, monkeypatch):
    case = batch_cli.load_manifest(manifest).cases[0]
    case.original.write_bytes(b"%PDF-different")
    monkeypatch.setattr(
        batch_cli, "run_isolated_comparison",
        lambda *a, **k: pytest.fail("Unpinned bytes reached the worker"),
    )
    output = tmp_path / "bad"
    result = batch_cli.run_batch(manifest, output)
    assert result["complete"] is False
    assert result["completed_count"] == 0
    assert list(output.iterdir()) == [output / "index.json"]


def test_failure_preserves_completed_prefix(manifest, tmp_path, fast_worker, monkeypatch):
    worker = batch_cli.run_isolated_comparison
    calls = []

    def run(*args, **kwargs):
        calls.append(1)
        if len(calls) == 2:
            raise ProcessingTimedOut("private parser message")
        return worker(*args, **kwargs)

    monkeypatch.setattr(batch_cli, "run_isolated_comparison", run)
    output = tmp_path / "partial"
    index = batch_cli.run_batch(manifest, output)
    assert index["complete"] is False
    assert index["completed_count"] == 1
    assert (output / "case-001.json").is_file()
    assert not (output / "case-002.json").exists()
    assert "private parser" not in (output / "index.json").read_text(encoding="utf-8")
    with pytest.raises(batch_cli.BatchError, match="incomplete"):
        batch_cli.verify_batch(manifest, output)


def test_report_budget_stops_without_overwriting(manifest, tmp_path, fast_worker, monkeypatch):
    monkeypatch.setattr(batch_cli, "MAX_BATCH_REPORT_BYTES", 10)
    output = tmp_path / "limited"
    result = batch_cli.run_batch(manifest, output)
    assert not result["complete"]
    assert not (output / "case-001.json").exists()


@pytest.mark.parametrize("change", [
    lambda idx: idx.update(authority_verified=True),
    lambda idx: idx.update(completed_count=True),
    lambda idx: idx.update(manifest_sha256="0" * 64),
    lambda idx: idx["cases"][0].update(report="../other.json"),
    lambda idx: idx["cases"][0].update(report_sha256="0" * 64),
    lambda idx: idx["status_counts"].update(confirmed_change=99),
    lambda idx: idx.update(extra="private"),
])
def test_modified_index_cannot_pass(manifest, tmp_path, fast_worker, change):
    output = tmp_path / "tampered"
    batch_cli.run_batch(manifest, output)
    _mutate(output / "index.json", change)
    with pytest.raises(batch_cli.BatchError, match="does not match"):
        batch_cli.verify_batch(manifest, output)


def test_modified_report_cannot_pass(manifest, tmp_path, fast_worker):
    output = tmp_path / "tampered"
    batch_cli.run_batch(manifest, output)
    _mutate(output / "case-001.json", lambda report: report.update(warnings=["fabricated"]))
    with pytest.raises(batch_cli.BatchError):
        batch_cli.verify_batch(manifest, output)


def test_replay_detects_source_replacement(manifest, tmp_path, fast_worker):
    output = tmp_path / "changed"
    batch_cli.run_batch(manifest, output)
    case = batch_cli.load_manifest(manifest).cases[0]
    case.revised.write_bytes(b"%PDF-different")
    with pytest.raises(batch_cli.BatchError):
        batch_cli.verify_batch(manifest, output)


def test_cli_output_is_quote_free(manifest, tmp_path, fast_worker, capsys):
    output = tmp_path / "cli"
    assert batch_cli.main(["run", str(manifest), "--output", str(output)]) == 0
    assert batch_cli.main(["verify", str(manifest), "--output", str(output)]) == 0
    captured = capsys.readouterr()
    summaries = [json.loads(line) for line in captured.out.splitlines()]
    assert len(summaries) == 2
    assert all(s["complete"] is True for s in summaries)
    assert "private-original" not in captured.out
    assert "Application deadline" not in captured.out
    assert not captured.err


def test_cli_missing_manifest_does_not_echo_path(tmp_path, capsys):
    path = tmp_path / "private-filename.json"
    assert batch_cli.main(["run", str(path), "--output", str(tmp_path / "out")]) == 1
    captured = capsys.readouterr()
    assert not captured.out
    assert "private-filename" not in captured.err



@pytest.fixture
def plan(manifest, tmp_path):
    data = json.loads(manifest.read_text(encoding="utf-8"))
    for case in data["cases"]:
        case.pop("original_sha256")
        case.pop("revised_sha256")
    return _write(tmp_path / "plan.json", data)


def test_prepare_preserves_explicit_order_and_pins(manifest, plan, tmp_path):
    destination = tmp_path / "pinned.json"
    summary = batch_cli.prepare_manifest(plan, destination)
    assert summary["case_count"] == 2
    assert summary["authority_verified"] is False
    assert summary["manifest_sha256"] == _hash(destination.read_bytes())
    assert json.loads(destination.read_bytes()) == json.loads(manifest.read_bytes())


def test_prepare_and_check_cli_do_not_echo_private_paths(plan, tmp_path, capsys):
    destination = tmp_path / "pinned.json"
    assert batch_cli.main(["prepare", str(plan), "--output", str(destination)]) == 0
    assert batch_cli.main(["check", str(destination)]) == 0
    captured = capsys.readouterr()
    first, second = map(json.loads, captured.out.splitlines())
    assert first["manifest_sha256"] == second["manifest_sha256"]
    assert second["source_pins_match"] is True
    assert "private-original" not in captured.out
    assert not captured.err


def test_prepare_never_overwrites_manifest(plan, tmp_path):
    destination = tmp_path / "pinned.json"
    destination.write_bytes(b"private existing data")
    with pytest.raises(batch_cli.CliError):
        batch_cli.prepare_manifest(plan, destination)
    assert destination.read_bytes() == b"private existing data"


def test_prepare_rejects_destination_in_different_folder(plan, tmp_path):
    folder = tmp_path / "nested"
    folder.mkdir()
    with pytest.raises(batch_cli.BatchError, match="share a directory"):
        batch_cli.prepare_manifest(plan, folder / "pinned.json")
    assert not list(folder.iterdir())


@pytest.mark.parametrize("change", [
    lambda raw: raw.update(version=True),
    lambda raw: raw.update(version=2),
    lambda raw: raw.update(extra="not allowed"),
    lambda raw: raw.update(cases=[]),
    lambda raw: raw.update(cases=raw["cases"] * 9),
    lambda raw: raw.update(cases="not a list"),
    lambda raw: raw["cases"][0].update(original_sha256="0" * 64),
    lambda raw: raw["cases"][0].pop("revised"),
    lambda raw: raw["cases"][0].update(original="../escape.pdf"),
    lambda raw: raw["cases"].append(raw["cases"][0]),
])
def test_prepare_rejects_invalid_plan_without_writing(plan, tmp_path, change):
    destination = tmp_path / "pinned.json"
    _mutate(plan, change)
    with pytest.raises(batch_cli.BatchError):
        batch_cli.prepare_manifest(plan, destination)
    assert not destination.exists()


def test_prepare_rejects_non_pdf_bytes(plan, tmp_path):
    data = json.loads(plan.read_bytes())
    (tmp_path / data["cases"][1]["revised"]).write_bytes(b"not a PDF")
    destination = tmp_path / "pinned.json"
    with pytest.raises(batch_cli.CliError):
        batch_cli.prepare_manifest(plan, destination)
    assert not destination.exists()


def test_check_manifest_detects_changed_source(manifest):
    case = batch_cli.load_manifest(manifest).cases[1]
    case.revised.write_bytes(b"%PDF-replaced")
    with pytest.raises(batch_cli.BatchError, match="fingerprints"):
        batch_cli.check_manifest(manifest)


def test_check_manifest_never_parses_source(manifest, monkeypatch):
    monkeypatch.setattr(
        batch_cli, "run_isolated_comparison",
        lambda *a, **k: pytest.fail("Pin checking must not start a worker"),
    )
    result = batch_cli.check_manifest(manifest)
    assert result["source_pins_match"] is True
    assert result["authority_verified"] is False


def test_structural_audit_is_distinct_from_replay(manifest, tmp_path, fast_worker, monkeypatch):
    output = tmp_path / "audit"
    index = batch_cli.run_batch(manifest, output)
    monkeypatch.setattr(
        batch_cli, "verify_saved_report",
        lambda *a, **k: pytest.fail("Structural audit must not replay the engine"),
    )
    audit = batch_cli.audit_batch(manifest, output)
    assert audit["structural_checks_passed"] is True
    assert audit["engine_replayed"] is False
    assert audit["authority_verified"] is False
    assert audit["status_counts"] == index["status_counts"]


@pytest.mark.parametrize("change", [
    lambda idx: idx.update(authority_verified=True),
    lambda idx: idx.update(case_count=1),
    lambda idx: idx["cases"][1].update(report_sha256="0" * 64),
])
def test_bad_index_rejected_before_any_replay(
    manifest, tmp_path, fast_worker, monkeypatch, change,
):
    output = tmp_path / "bad-index"
    batch_cli.run_batch(manifest, output)
    _mutate(output / "index.json", change)
    monkeypatch.setattr(
        batch_cli, "verify_saved_report",
        lambda *a, **k: pytest.fail("Tampered index reached expensive replay"),
    )
    with pytest.raises(batch_cli.BatchError, match="does not match"):
        batch_cli.verify_batch(manifest, output)


def test_browser_envelope_cannot_be_added_to_batch_report(
    manifest, tmp_path, fast_worker,
):
    output = tmp_path / "envelope"
    batch_cli.run_batch(manifest, output)
    report_path = output / "case-001.json"
    _mutate(report_path, lambda report: report.update(review={"authority": "fake"}))
    _mutate(
        output / "index.json",
        lambda index: index["cases"][0].update(report_sha256=_hash(report_path.read_bytes())),
    )
    with pytest.raises(batch_cli.BatchError, match="generated report format"):
        batch_cli.audit_batch(manifest, output)


def test_audit_rejects_symbolic_index(manifest, tmp_path, fast_worker):
    output = tmp_path / "audit"
    batch_cli.run_batch(manifest, output)
    index = output / "index.json"
    other = tmp_path / "moved-index.json"
    index.rename(other)
    try:
        index.symlink_to(other)
    except OSError:
        pytest.skip("Symlinks unavailable on this platform")
    with pytest.raises(batch_cli.BatchError, match="symbolic link"):
        batch_cli.audit_batch(manifest, output)


def test_audit_detects_modified_source(manifest, tmp_path, fast_worker):
    output = tmp_path / "audit"
    batch_cli.run_batch(manifest, output)
    batch_cli.load_manifest(manifest).cases[0].original.write_bytes(b"%PDF-changed")
    with pytest.raises(batch_cli.BatchError):
        batch_cli.audit_batch(manifest, output)


def test_cli_explicit_replay_marker(manifest, tmp_path, fast_worker, capsys):
    output = tmp_path / "markers"
    assert batch_cli.main(["run", str(manifest), "--output", str(output)]) == 0
    assert batch_cli.main(["audit", str(manifest), "--output", str(output)]) == 0
    assert batch_cli.main(["verify", str(manifest), "--output", str(output)]) == 0
    results = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [result["engine_replayed"] for result in results] == [False, False, True]
