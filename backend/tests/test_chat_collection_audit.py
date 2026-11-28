"""Structural audit is intentionally weaker than browser retrieval replay."""

import copy
import hashlib
import json

import pytest

from noticebridge import chat_collection_audit as audit
from noticebridge import chat_collection_audit_cli as cli


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def header(format_name, policy, **fields):
    return {
        "format": format_name, "version": 1, "policy": policy,
        "authority_verified": False, **fields,
    }


def fragment(page, ordinal, text, geometry=True):
    row = {"role": "original", "page": page, "ordinal": ordinal, "text": text}
    if geometry:
        row["position"] = {"x0": 10, "x1": 100, "y": 100 - ordinal * 12, "height": 10}
    return row


def source(source_id, fragments, *, pages=2, processed=2, limited=False, limited_pages=()):
    present = {row["page"] for row in fragments}
    return header("noticebridge-native-corpus-snapshot", audit.NATIVE_POLICY, sources=[{
        "role": "original", "sha256": source_id, "page_count": pages,
        "processed_pages": processed, "missing_pages": [
            page for page in range(1, processed + 1) if page not in present
        ],
        "limited_pages": list(limited_pages), "limited": limited, "passages": fragments,
    }])


def source_id(data):
    return hashlib.sha256(data).hexdigest()


@pytest.fixture
def artifacts(tmp_path):
    a_bytes, b_bytes = b"%PDF-1.7\nSynthetic A", b"%PDF-1.7\nSynthetic B"
    a, b = source_id(a_bytes), source_id(b_bytes)
    file_a, file_b = tmp_path / "a.pdf", tmp_path / "b.pdf"
    file_a.write_bytes(a_bytes)
    file_b.write_bytes(b_bytes)
    first = source(a, [fragment(1, 1, "Application fee: INR 500"),
                       fragment(1, 2, "Applicants must submit a certificate")])
    second = source(b, [fragment(1, 1, "Application fee: INR 350")])
    snapshot = header(
        "noticebridge-collection-native-snapshot", audit.SNAPSHOT_POLICY,
        sources=sorted([first, second], key=lambda row: row["sources"][0]["sha256"]),
    )
    raw = encode(snapshot)
    ids = sorted([a, b])
    step = {"question": "Application fee on page 1?", "documentIds": [a, b],
            "includeContext": False}
    plan = {
        "format": "noticebridge-collection-question-plan", "version": 1,
        "policy": audit.PLAN_POLICY, "source_ids": ids, "questions": [step],
    }
    review = header("noticebridge-collection-native-review", audit.REVIEW_POLICY,
                    source_ids=ids, entries=[{
                        "document_id": a, "page": 1, "ordinal": 1,
                        "text_sha256": source_id(b"Application fee: INR 500"),
                        "status": "needs_followup", "note": "Private note",
                    }])
    workspace = header(
        "noticebridge-private-collection-workspace", audit.WORKSPACE_POLICY,
        source_ids=ids, question_plan=plan, evidence_review=review,
    )
    sides = []
    for key, text, fee in [(a, "Application fee: INR 500", "INR 500"),
                           (b, "Application fee: INR 350", "INR 350")]:
        sides.append({"document_id": key, "parts": [{
            "question": step["question"], "physical_page": 1, "kind": "passages",
            "coverage": "some_text", "strict_match_count": 1,
            "citations": [{"page": 1, "ordinal": 1, "text": text}],
            "context_groups": [], "printed_fields": [
                {"citation": 1, "label": "Application fee", "value": fee},
            ],
        }]})
    evidence = header(
        "noticebridge-collection-evidence-report", audit.EVIDENCE_POLICY,
        source_ids=ids, questions=[{"step": step, "results": sides}],
    )
    inventory = [audit.parse_native_source(item).inventory() for item in snapshot["sources"]]
    packet = header(
        "noticebridge-collection-review-packet", audit.PACKET_POLICY,
        snapshot_sha256=source_id(raw), workspace=workspace, evidence_report=evidence,
        sources=inventory, review_counts={"unreviewed": 0, "reviewed_manually": 0,
                                           "needs_followup": 1},
        review_quotes=[{
            **review["entries"][0], "native_text": "Application fee: INR 500",
            "coverage": "some_text",
        }],
    )
    return snapshot, packet, [file_a, file_b]


def execute(artifacts, *, pdfs=False):
    snapshot, packet, paths = artifacts
    return audit.audit_packet(encode(packet), encode(snapshot), paths if pdfs else None)


def test_checks_bound_snapshot_and_each_exact_source_reference(artifacts):
    report = execute(artifacts, pdfs=True)
    assert report["snapshot_references_consistent"] is True
    assert report["pdf_byte_set_matches"] is True
    assert report["retrieval_replayed"] is False
    assert report["native_extraction_replayed"] is False
    assert report["authority_verified"] is False
    assert report["counts"] == {
        "documents": 2, "native_fragments": 3, "review_annotations": 1,
        "question_turns": 1, "question_parts": 2, "citations": 2,
        "printed_fields": 2, "context_groups": 0, "insufficient_parts": 0, "limited_parts": 0,
    }
    output = audit.encode_audit(report)
    for private in (b"Private note", b"INR 500", b"INR 350", b"a.pdf", b"Application fee"):
        assert private not in output


def test_optional_pdfs_separate_unchecked_missing_and_unexpected(artifacts, tmp_path):
    snapshot, packet, paths = artifacts
    unchecked = execute(artifacts)
    assert unchecked["pdf_bytes_checked"] is False
    assert unchecked["pdf_byte_set_matches"] is None
    other = tmp_path / "other.pdf"
    other.write_bytes(b"%PDF-1.7\nOther")
    report = audit.audit_packet(encode(packet), encode(snapshot), [paths[0], other])
    assert report["pdf_byte_set_matches"] is False
    assert report["missing_pdf_ids"] == [source_id(paths[1].read_bytes())]
    assert report["unexpected_pdf_ids"] == [source_id(other.read_bytes())]
    renamed = tmp_path / "renamed.pdf"
    renamed.write_bytes(paths[1].read_bytes())
    assert audit.audit_packet(encode(packet), encode(snapshot), [renamed, paths[0]])[
        "pdf_byte_set_matches"
    ] is True


@pytest.mark.parametrize("mutation", [
    lambda v: v.update(authority_verified=True),
    lambda v: v.update(snapshot_sha256="0" * 64),
    lambda v: v.update(version=True),
    lambda v: v["sources"][0].update(physical_pages=True),
    lambda v: v["sources"][0].update(native_fragments=999),
    lambda v: v["sources"].reverse(),
    lambda v: v["review_counts"].update(needs_followup=True),
    lambda v: v["review_counts"].update(needs_followup=0),
    lambda v: v["review_quotes"][0].update(native_text="forged"),
    lambda v: v["review_quotes"][0].update(note="forged"),
    lambda v: v["review_quotes"][0].update(coverage="limited"),
    lambda v: v["workspace"]["evidence_review"]["entries"][0].update(text_sha256="f" * 64),
    lambda v: v["workspace"]["evidence_review"]["entries"][0].update(ordinal=2),
    lambda v: v["workspace"]["evidence_review"]["entries"].append(
        v["workspace"]["evidence_review"]["entries"][0]),
    lambda v: v["workspace"]["question_plan"]["source_ids"].reverse(),
    lambda v: v["workspace"]["question_plan"]["questions"][0]["documentIds"].append("f" * 64),
    lambda v: v["evidence_report"]["questions"][0]["results"].reverse(),
    lambda v: v.update(evidence_report=None),
])
def test_packet_inconsistency_fails_closed(artifacts, mutation):
    snapshot, packet, _ = artifacts
    packet = copy.deepcopy(packet)
    mutation(packet)
    with pytest.raises(audit.AuditError):
        audit.audit_packet(encode(packet), encode(snapshot))


@pytest.mark.parametrize("changes", [
    {"physical_page": 2}, {"physical_page": True}, {"coverage": "partial"},
    {"kind": "insufficient"}, {"strict_match_count": True}, {"strict_match_count": 0},
    {"strict_match_count": 999}, {"citations": [{"page": 1, "ordinal": 2, "text": "forged"}]},
    {"citations": [{"page": 2, "ordinal": 1, "text": "Application fee: INR 500"}]},
    {"printed_fields": [{"citation": 1, "label": "Application fee", "value": "INR 999"}]},
    {"printed_fields": [{"citation": True, "label": "Application fee", "value": "INR 500"}]},
    {"context_groups": [{"page": 1, "citations": [1, 2]}]},
    {"question": "Application fee on pages 1 and 2?"},
    {"question": "Application fee on page 1-2?"},
])
def test_question_part_validates_scope_quotes_and_literal_values(artifacts, changes):
    snapshot, packet, _ = artifacts
    part = packet["evidence_report"]["questions"][0]["results"][0]["parts"][0]
    part.update(changes)
    with pytest.raises(audit.AuditError):
        audit.audit_packet(encode(packet), encode(snapshot))


@pytest.mark.parametrize("mutation", [
    lambda v: v["sources"].reverse(),
    lambda v: v["sources"].append(v["sources"][0]),
    lambda v: v["sources"][0]["sources"][0].update(role="revised"),
    lambda v: v["sources"][0]["sources"][0].update(page_count=0),
    lambda v: v["sources"][0]["sources"][0].update(processed_pages=3),
    lambda v: v["sources"][0]["sources"][0].update(limited_pages=[1]),
    lambda v: v["sources"][0]["sources"][0].update(missing_pages=[]),
    lambda v: v["sources"][0]["sources"][0]["passages"][0].update(ordinal=True),
    lambda v: v["sources"][0]["sources"][0]["passages"][0].update(text=""),
    lambda v: v["sources"][0]["sources"][0]["passages"][0].update(text="   text"),
    lambda v: v["sources"][0]["sources"][0]["passages"][0]["position"].update(x1=0),
    lambda v: v["sources"][0]["sources"][0]["passages"][0]["position"].update(height=True),
])
def test_snapshot_validation_rejects_bad_source_contract(artifacts, mutation):
    snapshot, _, _ = artifacts
    mutation(snapshot)
    with pytest.raises(audit.AuditError):
        audit.parse_snapshot(encode(snapshot))


def test_snapshot_hash_also_covers_unquoted_native_text(artifacts):
    snapshot, packet, _ = artifacts
    for entry in snapshot["sources"]:
        rows = entry["sources"][0]["passages"]
        if len(rows) > 1:
            rows[1]["text"] = "Different unquoted text"
    with pytest.raises(audit.AuditError):
        audit.audit_packet(encode(packet), encode(snapshot))


def test_context_windows_must_be_consecutive_scoped_and_explicitly_enabled(artifacts):
    snapshot, packet, _ = artifacts
    turn = packet["evidence_report"]["questions"][0]
    turn["step"]["includeContext"] = True
    row = turn["results"][0]["parts"][0]
    row["strict_match_count"] = 0
    row["printed_fields"] = []
    row["citations"].append({
        "page": 1, "ordinal": 2, "text": "Applicants must submit a certificate",
    })
    row["context_groups"] = [{"page": 1, "citations": [1, 2]}]
    assert execute(artifacts)["counts"]["context_groups"] == 1
    row["context_groups"][0]["citations"] = [2, 1]
    with pytest.raises(audit.AuditError):
        execute(artifacts)


def test_snapshot_parser_rejects_duplicate_json_keys_and_nonfinite_numbers(artifacts):
    snapshot, _, _ = artifacts
    raw = encode(snapshot)
    for bad in (
        raw.replace(b'"version": 1,', b'"version": 1, "version": 1,', 1),
        raw.replace(b'"height": 10', b'"height": NaN', 1),
        raw.replace(b'"height": 10', b'"height": 1e999', 1),
        b"\xff",
        b"[" * 1000,
    ):
        with pytest.raises(audit.AuditError):
            audit.parse_snapshot(bad)


def test_utf16_length_limit_and_unpaired_surrogate(artifacts):
    snapshot, _, _ = artifacts
    row = snapshot["sources"][0]["sources"][0]["passages"][0]
    row["text"] = "😀" * 451
    with pytest.raises(audit.AuditError):
        audit.parse_snapshot(encode(snapshot))
    row["text"] = "\ud800"
    raw = json.dumps(snapshot, ensure_ascii=True).encode()
    with pytest.raises(audit.AuditError):
        audit.parse_snapshot(raw)


def test_annotation_only_and_question_only_packets(artifacts):
    snapshot, packet, _ = artifacts
    annotation_only = copy.deepcopy(packet)
    annotation_only["workspace"]["question_plan"] = None
    annotation_only["evidence_report"] = None
    assert audit.audit_packet(encode(annotation_only), encode(snapshot))["counts"][
        "question_turns"
    ] == 0
    question_only = copy.deepcopy(packet)
    question_only["workspace"]["evidence_review"] = None
    question_only["review_counts"]["needs_followup"] = 0
    question_only["review_quotes"] = []
    assert audit.audit_packet(encode(question_only), encode(snapshot))["counts"][
        "review_annotations"
    ] == 0


def test_duplicate_or_invalid_pdf_files_reject_without_output(artifacts):
    snapshot, packet, paths = artifacts
    with pytest.raises(audit.AuditError):
        audit.audit_packet(encode(packet), encode(snapshot), [paths[0], paths[0]])
    with pytest.raises(audit.AuditError):
        audit.audit_packet(encode(packet), encode(snapshot), [paths[0].parent / "missing.pdf"])


def test_cli_writes_private_report_and_preserves_existing_outputs(artifacts, tmp_path, capsys):
    snapshot, packet, paths = artifacts
    snapshot_file, packet_file = tmp_path / "snapshot.json", tmp_path / "packet.json"
    snapshot_file.write_bytes(encode(snapshot))
    packet_file.write_bytes(encode(packet))
    output = tmp_path / "audit.json"
    args = [str(packet_file), str(snapshot_file), "--output", str(output)]
    assert cli.main([*args, "--pdf", str(paths[0]), "--pdf", str(paths[1])]) == 0
    data = output.read_bytes()
    assert b"Private note" not in data
    assert cli.main(args) == 2
    assert output.read_bytes() == data
    assert "Native extraction and retrieval have not been replayed" in capsys.readouterr().out


def test_cli_distinguishes_byte_set_mismatch_and_structural_failure(artifacts, tmp_path):
    snapshot, packet, paths = artifacts
    snapshot_file, packet_file = tmp_path / "snapshot.json", tmp_path / "packet.json"
    snapshot_file.write_bytes(encode(snapshot))
    packet_file.write_bytes(encode(packet))
    output = tmp_path / "audit.json"
    args = [str(packet_file), str(snapshot_file), "--output", str(output)]
    assert cli.main([*args, "--pdf", str(paths[0])]) == 3
    assert json.loads(output.read_bytes())["pdf_byte_set_matches"] is False
    output.unlink()
    packet["review_quotes"][0]["note"] = "forged"
    packet_file.write_bytes(encode(packet))
    assert cli.main(args) == 2
    assert not output.exists()
