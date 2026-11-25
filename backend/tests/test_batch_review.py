"""Human-review ledger contract, reconciliation and CLI interoperability."""

import hashlib
import json

import pytest

from noticebridge import batch_cli, batch_review
from noticebridge.compare import compare_documents
from noticebridge.extract import extract_pdf
from noticebridge.isolation import ProcessingTimedOut


@pytest.fixture
def binding():
    return batch_review.BatchBinding(
        index_sha256="a" * 64,
        manifest_sha256="b" * 64,
        case_count=4,
        report_hashes=("c" * 64, "d" * 64, "e" * 64),
    )


def _bytes(value):
    return (json.dumps(value, indent=2) + "\n").encode("utf-8")


def _ledger(binding, entries):
    return batch_review.parse_ledger(batch_review.ledger_payload(binding, entries), binding)


def _raw(binding, entries):
    return json.loads(batch_review.ledger_payload(binding, entries))


def _resolution(binding, first, second, states):
    comparison = batch_review.compare_ledgers(binding, first, second)
    template = batch_review.resolution_template(comparison)
    for entry in template["resolutions"]:
        entry["state"] = states[entry["case"]]
    return _bytes(template)


def test_serialized_ledger_round_trip_and_stable_order(binding):
    data = batch_review.ledger_payload(binding, {3: "follow_up", 1: "reviewed"})
    loaded = batch_review.parse_ledger(data, binding)
    assert loaded.entries == ((1, "reviewed"), (3, "follow_up"))
    assert loaded.sha256 == hashlib.sha256(data).hexdigest()
    raw = json.loads(data)
    assert raw["authority_verified"] is False
    assert raw["engine_replayed"] is False
    assert [row["case"] for row in raw["reviews"]] == [1, 3]
    assert raw["reviews"][0]["report_sha256"] == binding.report_hashes[0]
    assert data == batch_review.ledger_payload(binding, {1: "reviewed", 3: "follow_up"})


def test_summary_counts_unmarked_completed_cases_not_unprocessed_cases(binding):
    ledger = _ledger(binding, {1: "reviewed", 3: "follow_up"})
    result = batch_review.review_summary(binding, ledger)
    assert result["human_review_counts"] == {
        "unreviewed": 1, "in_progress": 0, "follow_up": 1, "reviewed": 1,
    }
    assert result["case_count"] == 4
    assert result["completed_count"] == 3
    assert result["batch_complete"] is False
    assert result["engine_replayed"] is False
    assert result["authority_verified"] is False


@pytest.mark.parametrize("field,value", [
    ("version", True), ("version", "1"), ("version", 2),
    ("format", "unknown"), ("policy", "Verified by AI"),
    ("authority_verified", True), ("authority_verified", 0),
    ("engine_replayed", True), ("engine_replayed", 0),
    ("index_sha256", "0" * 64), ("manifest_sha256", "0" * 64),
    ("case_count", True), ("case_count", 4.0), ("case_count", 5),
    ("completed_count", 4), ("completed_count", 3.0),
    ("reviews", {}), ("reviews", None),
])
def test_invalid_ledger_header(binding, field, value):
    raw = _raw(binding, {1: "reviewed"})
    raw[field] = value
    with pytest.raises(ValueError):
        batch_review.parse_ledger(_bytes(raw), binding)


@pytest.mark.parametrize("field", sorted(batch_review.LEDGER_KEYS))
def test_missing_ledger_field(binding, field):
    raw = _raw(binding, {})
    raw.pop(field)
    with pytest.raises(batch_review.ReviewError):
        batch_review.parse_ledger(_bytes(raw), binding)


@pytest.mark.parametrize("field,value", [
    ("case", True), ("case", 0), ("case", -1), ("case", 4), ("case", "1"),
    ("case", 1.0), ("state", None), ("state", "verified"),
    ("state", "unreviewed"), ("state", []), ("state", "REVIEWED"),
    ("report_sha256", "0" * 64), ("report_sha256", "C" * 64),
    ("report_sha256", 123), ("report_sha256", "c" * 63),
])
def test_invalid_review_entry(binding, field, value):
    raw = _raw(binding, {1: "reviewed"})
    raw["reviews"][0][field] = value
    with pytest.raises(ValueError):
        batch_review.parse_ledger(_bytes(raw), binding)


def test_duplicate_case_rejected_even_if_markers_agree(binding):
    raw = _raw(binding, {1: "reviewed"})
    raw["reviews"].append(raw["reviews"][0].copy())
    with pytest.raises(batch_review.ReviewError, match="Repeated"):
        batch_review.parse_ledger(_bytes(raw), binding)


@pytest.mark.parametrize("scope", ["root", "entry"])
def test_unknown_fields_cannot_smuggle_quotations_or_claims(binding, scope):
    raw = _raw(binding, {1: "follow_up"})
    target = raw if scope == "root" else raw["reviews"][0]
    target["source_quote"] = "private-source-text"
    with pytest.raises(batch_review.ReviewError):
        batch_review.parse_ledger(_bytes(raw), binding)


@pytest.mark.parametrize("payload", [
    b"", b"null", b"[]", b'{"version":1,"version":1}', b'{"a":NaN}',
    b'{"a":Infinity}', b"\xff", b"{", b" " * (16 * 1024 + 1),
])
def test_invalid_review_json_rejected(binding, payload):
    with pytest.raises(ValueError):
        batch_review.parse_ledger(payload, binding)


def test_empty_ledger_preserves_absence(binding):
    ledger = _ledger(binding, {})
    assert ledger.entries == ()
    assert batch_review.review_summary(binding, ledger)["human_review_counts"]["unreviewed"] == 3


def test_nonconflicting_ledgers_combine_without_resolution(binding):
    first = _ledger(binding, {1: "in_progress", 2: "reviewed"})
    second = _ledger(binding, {2: "reviewed", 3: "follow_up"})
    compared = batch_review.compare_ledgers(binding, first, second)
    assert compared["agreed_cases"] == [2]
    assert compared["single_marker_cases"] == [1, 3]
    assert compared["unmarked_cases"] == []
    assert compared["conflicts"] == []
    result = batch_review.reconcile_ledgers(binding, first, second)
    assert batch_review.parse_ledger(result, binding).entries == (
        (1, "in_progress"), (2, "reviewed"), (3, "follow_up"),
    )


def test_missing_marker_is_not_a_conflicting_assertion(binding):
    first = _ledger(binding, {1: "reviewed"})
    second = _ledger(binding, {})
    compared = batch_review.compare_ledgers(binding, first, second)
    assert compared["single_marker_cases"] == [1]
    assert compared["unmarked_cases"] == [2, 3]
    assert compared["conflicts"] == []


def test_conflicting_markers_require_explicit_resolution(binding):
    first = _ledger(binding, {1: "reviewed"})
    second = _ledger(binding, {1: "follow_up"})
    comparison = batch_review.compare_ledgers(binding, first, second)
    assert comparison["conflicts"] == [{"case": 1, "first": "reviewed", "second": "follow_up"}]
    template = batch_review.resolution_template(comparison)
    assert template["resolutions"] == [{"case": 1, "state": None}]
    assert template["first_ledger_sha256"] == first.sha256
    assert template["second_ledger_sha256"] == second.sha256
    with pytest.raises(batch_review.ReviewError, match="explicit resolution"):
        batch_review.reconcile_ledgers(binding, first, second)
    with pytest.raises(batch_review.ReviewError, match="Invalid human review"):
        batch_review.reconcile_ledgers(binding, first, second, resolution=_bytes(template))


@pytest.mark.parametrize("state", batch_review.STATES)
def test_explicit_resolution_can_choose_any_review_marker_or_clear(binding, state):
    first = _ledger(binding, {1: "reviewed", 2: "in_progress"})
    second = _ledger(binding, {1: "follow_up", 3: "reviewed"})
    payload = _resolution(binding, first, second, {1: state})
    result = batch_review.reconcile_ledgers(binding, first, second, resolution=payload)
    expected = {2: "in_progress", 3: "reviewed"}
    if state != "unreviewed":
        expected[1] = state
    assert dict(batch_review.parse_ledger(result, binding).entries) == expected


def test_multiple_conflicts_require_one_resolution_each(binding):
    first = _ledger(binding, {1: "reviewed", 2: "in_progress"})
    second = _ledger(binding, {1: "follow_up", 2: "reviewed"})
    payload = _resolution(binding, first, second, {1: "follow_up", 2: "reviewed"})
    raw = json.loads(payload)
    raw["resolutions"].pop()
    with pytest.raises(batch_review.ReviewError, match="Every conflicting"):
        batch_review.reconcile_ledgers(binding, first, second, resolution=_bytes(raw))
    result = batch_review.reconcile_ledgers(binding, first, second, resolution=payload)
    assert batch_review.parse_ledger(result, binding).entries == (
        (1, "follow_up"), (2, "reviewed"),
    )


@pytest.mark.parametrize("field", ["index_sha256", "first_ledger_sha256", "second_ledger_sha256"])
def test_resolution_binds_exact_inputs(binding, field):
    first = _ledger(binding, {1: "reviewed"})
    second = _ledger(binding, {1: "follow_up"})
    raw = json.loads(_resolution(binding, first, second, {1: "reviewed"}))
    raw[field] = "0" * 64
    with pytest.raises(batch_review.ReviewError, match="exact input"):
        batch_review.reconcile_ledgers(binding, first, second, resolution=_bytes(raw))


def test_resolution_cannot_be_reused_after_input_bytes_change(binding):
    first = _ledger(binding, {1: "reviewed"})
    second = _ledger(binding, {1: "follow_up"})
    raw = _raw(binding, {1: "reviewed"})
    changed_bytes = json.dumps(raw, separators=(",", ":")).encode("utf-8")
    changed_first = batch_review.parse_ledger(changed_bytes, binding)
    assert changed_first.entries == first.entries
    assert changed_first.sha256 != first.sha256
    payload = _resolution(binding, first, second, {1: "reviewed"})
    with pytest.raises(batch_review.ReviewError, match="exact input"):
        batch_review.reconcile_ledgers(binding, changed_first, second, resolution=payload)


@pytest.mark.parametrize("change", [
    lambda raw: raw.update(version=True),
    lambda raw: raw.update(version=2),
    lambda raw: raw.update(extra="private"),
    lambda raw: raw["resolutions"][0].update(case=3),
    lambda raw: raw["resolutions"][0].update(case=True),
    lambda raw: raw["resolutions"][0].update(state="verified"),
    lambda raw: raw["resolutions"][0].update(note="private"),
    lambda raw: raw["resolutions"].append(raw["resolutions"][0]),
    lambda raw: raw["resolutions"][1].update(case=1),
])
def test_invalid_resolution_rejected(binding, change):
    first = _ledger(binding, {1: "reviewed", 2: "in_progress"})
    second = _ledger(binding, {1: "follow_up", 2: "reviewed"})
    raw = json.loads(_resolution(binding, first, second, {1: "follow_up", 2: "reviewed"}))
    change(raw)
    with pytest.raises(ValueError):
        batch_review.reconcile_ledgers(binding, first, second, resolution=_bytes(raw))


@pytest.fixture
def local_batch(tmp_path, pdf_bytes, monkeypatch):
    """Use real engine reports; isolate the orchestration from process startup."""
    old = pdf_bytes([["Application deadline: 13 December 2026"]])
    updated = pdf_bytes([["Application deadline: 19 December 2026"]])
    (tmp_path / "private-old.pdf").write_bytes(old)
    (tmp_path / "private-new.pdf").write_bytes(updated)
    manifest = tmp_path / "manifest.json"
    manifest.write_bytes(_bytes({
        "version": 1,
        "cases": [{
            "original": "private-old.pdf", "revised": "private-new.pdf",
            "original_sha256": hashlib.sha256(old).hexdigest(),
            "revised_sha256": hashlib.sha256(updated).hexdigest(),
        }],
    }))

    def compare(original, revised, *, old_name, new_name, **options):
        assert options["enable_ocr"] is False
        assert options["enable_semantic"] is False
        return compare_documents(
            extract_pdf(original, document_id="original", filename=old_name),
            extract_pdf(revised, document_id="revised", filename=new_name),
        ).model_copy(update={"automatic_ocr": False})

    monkeypatch.setattr(batch_cli, "run_isolated_comparison", compare)
    directory = tmp_path / "batch"
    assert batch_cli.run_batch(manifest, directory)["complete"]
    return manifest, directory


def test_binding_structurally_checks_sources_without_replay(local_batch, monkeypatch):
    manifest, directory = local_batch
    monkeypatch.setattr(
        batch_cli, "verify_saved_report",
        lambda *a, **k: pytest.fail("Review marker audit must not replay PDFs"),
    )
    bound = batch_review.load_binding(manifest, directory)
    assert bound.index_sha256 == hashlib.sha256((directory / "index.json").read_bytes()).hexdigest()
    assert bound.report_hashes == (
        hashlib.sha256((directory / "case-001.json").read_bytes()).hexdigest(),
    )


def test_binding_rejects_modified_report(local_batch):
    manifest, directory = local_batch
    path = directory / "case-001.json"
    raw = json.loads(path.read_bytes())
    raw["warnings"] = ["fabricated evidence"]
    path.write_bytes(_bytes(raw))
    with pytest.raises(ValueError):
        batch_review.load_binding(manifest, directory)


def test_binding_rejects_changed_pdf(local_batch):
    manifest, directory = local_batch
    (manifest.parent / "private-old.pdf").write_bytes(b"%PDF-replaced")
    with pytest.raises(ValueError):
        batch_review.load_binding(manifest, directory)


def test_index_reformatting_invalidates_existing_ledger(local_batch):
    manifest, directory = local_batch
    bound = batch_review.load_binding(manifest, directory)
    data = batch_review.ledger_payload(bound, {1: "reviewed"})
    index = directory / "index.json"
    index.write_bytes(json.dumps(json.loads(index.read_bytes())).encode())
    changed = batch_review.load_binding(manifest, directory)
    assert changed.index_sha256 != bound.index_sha256
    with pytest.raises(batch_review.ReviewError, match="exact batch"):
        batch_review.parse_ledger(data, changed)


def test_cli_compare_and_merge_preserve_inputs(local_batch, tmp_path, capsys):
    manifest, directory = local_batch
    bound = batch_review.load_binding(manifest, directory)
    first, second = tmp_path / "a.json", tmp_path / "b.json"
    first.write_bytes(batch_review.ledger_payload(bound, {1: "reviewed"}))
    second.write_bytes(batch_review.ledger_payload(bound, {1: "follow_up"}))
    before = first.read_bytes(), second.read_bytes()
    base = [str(manifest), "--batch", str(directory), "--first", str(first)]
    args = base + ["--second", str(second)]
    template = tmp_path / "resolution.json"
    assert batch_review.main(["inspect", *base]) == 0
    assert json.loads(capsys.readouterr().out)["human_review_counts"]["reviewed"] == 1
    assert batch_review.main(["compare", *args, "--template", str(template)]) == 0
    assert json.loads(capsys.readouterr().out)["conflicts"][0]["case"] == 1
    raw = json.loads(template.read_bytes())
    raw["resolutions"][0]["state"] = "follow_up"
    template.write_bytes(_bytes(raw))
    merged = tmp_path / "merged.json"
    assert batch_review.main([
        "merge", *args, "--resolution", str(template), "--output", str(merged),
    ]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["human_review_counts"]["follow_up"] == 1
    assert result["authority_verified"] is False
    assert batch_review.read_ledger(merged, bound).entries == ((1, "follow_up"),)
    assert (first.read_bytes(), second.read_bytes()) == before


def test_cli_unresolved_conflict_creates_no_output(local_batch, tmp_path, capsys):
    manifest, directory = local_batch
    bound = batch_review.load_binding(manifest, directory)
    first, second = tmp_path / "private-a.json", tmp_path / "private-b.json"
    first.write_bytes(batch_review.ledger_payload(bound, {1: "reviewed"}))
    second.write_bytes(batch_review.ledger_payload(bound, {1: "follow_up"}))
    output = tmp_path / "merged.json"
    assert batch_review.main([
        "merge", str(manifest), "--batch", str(directory), "--first", str(first),
        "--second", str(second), "--output", str(output),
    ]) == 1
    captured = capsys.readouterr()
    assert not output.exists()
    assert not captured.out
    assert "private-a" not in captured.err
    assert "Application deadline" not in captured.err


def test_cli_cannot_overwrite_existing_output(local_batch, tmp_path, capsys):
    manifest, directory = local_batch
    bound = batch_review.load_binding(manifest, directory)
    first, second = tmp_path / "a.json", tmp_path / "b.json"
    first.write_bytes(batch_review.ledger_payload(bound, {1: "reviewed"}))
    second.write_bytes(batch_review.ledger_payload(bound, {}))
    output = tmp_path / "existing.json"
    output.write_bytes(b"do not replace")
    assert batch_review.main([
        "merge", str(manifest), "--batch", str(directory), "--first", str(first),
        "--second", str(second), "--output", str(output),
    ]) == 1
    assert output.read_bytes() == b"do not replace"
    assert not capsys.readouterr().out


def test_partial_index_does_not_include_unprocessed_review_markers(
    local_batch, tmp_path, monkeypatch,
):
    manifest, _ = local_batch

    def fail(*args, **kwargs):
        raise ProcessingTimedOut("private parser exception")

    monkeypatch.setattr(batch_cli, "run_isolated_comparison", fail)
    partial = tmp_path / "partial"
    assert not batch_cli.run_batch(manifest, partial)["complete"]
    bound = batch_review.load_binding(manifest, partial)
    assert bound.case_count == 1
    assert bound.completed_count == 0
    ledger = _ledger(bound, {})
    assert batch_review.review_summary(bound, ledger)["human_review_counts"]["unreviewed"] == 0
    with pytest.raises(batch_review.ReviewError, match="completed"):
        batch_review.ledger_payload(bound, {1: "reviewed"})
