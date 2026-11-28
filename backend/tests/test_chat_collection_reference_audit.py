"""Reference grammar, independent offsets, ordering and report integrity."""

import json

import pytest

from noticebridge import chat_collection_audit as audit
from noticebridge import chat_collection_reference_audit as reference
from noticebridge import chat_collection_reference_audit_cli as cli


@pytest.mark.parametrize(("text", "identifiers"), [
    ("Clause 4.2(a)", [("clause", "4.2(a)")]),
    ("SECTION 9 and RULE 2B", [("section", "9"), ("rule", "2b")]),
    ("Annexure A-12", [("annexure", "a-12")]),
    ("Schedule B", [("schedule", "b")]),
    ("Clause ABC", []),
    ("Section 12345", []),
    ("Section 1.abc", []),
    ("Section 1_foo", []),
    ("Section 1(", []),
    ("xClause 2", []),
    ("Clause 4.2(a)(B)(iii)", [("clause", "4.2(a)(b)(iii)")]),
    ("Article 3.", [("article", "3")]),
    ("See paragraph\t12", [("paragraph", "12")]),
    ("See paragraph\n12", []),
    ("Section 1é", []),
    ("Section 1Ⅳ", []),
    ("Annexure abcdef", []),
    ("ſection 2", []),
    ("Annexure K", []),
    ("😀 Clause 7", [("clause", "7")]),
])
def test_grammar(text, identifiers):
    matches = list(reference.references(text))
    assert [(row[0], row[1]) for row in matches] == identifiers


def test_utf16_offsets_and_leading_state():
    text = "😀 See Clause 4.2(a) and Section 9."
    first, second = list(reference.references(text))
    raw = text.encode("utf-16-le")
    assert first[2:] == (7, 20, False)
    assert raw[first[2] * 2:first[3] * 2].decode("utf-16-le") == "Clause 4.2(a)"
    assert raw[second[2] * 2:second[3] * 2].decode("utf-16-le") == "Section 9"
    assert list(reference.references(" \u00a0Clause 7"))[0][-1] is True


def native(source_id, pages):
    return {
        "format": "noticebridge-native-corpus-snapshot", "version": 1,
        "policy": audit.NATIVE_POLICY, "authority_verified": False,
        "sources": [{
            "role": "original", "sha256": source_id, "page_count": len(pages),
            "processed_pages": len(pages),
            "missing_pages": [i + 1 for i, rows in enumerate(pages) if not rows],
            "limited_pages": [], "limited": False,
            "passages": [
                {"role": "original", "page": page + 1, "ordinal": i + 1, "text": text}
                for page, lines in enumerate(pages) for i, text in enumerate(lines)
            ],
        }],
    }


@pytest.fixture
def artifacts():
    a, b = "a" * 64, "b" * 64
    snapshot = audit.encode_audit({
        "format": "noticebridge-collection-native-snapshot", "version": 1,
        "policy": audit.SNAPSHOT_POLICY, "authority_verified": False,
        "sources": [
            native(a, [["Clause 4.2(a) Private eligibility", "😀 See Clause 4.2(a) and Section 9."], []]),
            native(b, [["Clause 4.2(a) Private rule", "See Annexure B."]]),
        ],
    })
    return snapshot, reference.recompute_reference_index(audit.parse_snapshot(snapshot), [b, a])


def test_group_counts_and_coordinate_order(artifacts):
    snapshot, report = artifacts
    clause, section, annexure = report["groups"]
    assert clause["state"] == "multiple_leading"
    assert clause["leading_count"] == 2
    assert clause["inline_count"] == 1
    assert clause["documents"] == 2
    assert clause["sides"][1]["inline"] == [{
        "page": 1, "ordinal": 2, "start_utf16": 7, "end_utf16": 20,
    }]
    assert section["state"] == annexure["state"] == "no_leading"
    assert report["total_occurrences"] == 5
    assert report["examined_fragments"] == 4
    assert report["document_coverage"][1]["missing_pages"] == [2]
    checked = reference.audit_reference_index(audit.encode_audit(report), snapshot)
    assert checked["reference_index_recomputed"] is True
    assert checked["reference_relationships_verified"] is False
    assert b"Private" not in audit.encode_audit(checked)


def test_budget_stops_at_next_occurrence_without_fabricating_coverage(artifacts, monkeypatch):
    snapshot, _ = artifacts
    monkeypatch.setattr(reference, "MAX_OCCURRENCES", 1)
    parsed = audit.parse_snapshot(snapshot)
    result = reference.recompute_reference_index(parsed, parsed.ids)
    assert result["occurrence_budget_reached"] is True
    assert result["examined_fragments"] == 2
    assert result["total_occurrences"] == 1
    assert result["groups"][0]["state"] == "single_leading"
    assert len(result["document_coverage"]) == 2


@pytest.mark.parametrize("change", [
    lambda v: v.update(authority_verified=True),
    lambda v: v.update(reference_relationships_verified=True),
    lambda v: v.update(total_occurrences=True),
    lambda v: v.update(examined_fragments=100),
    lambda v: v.update(snapshot_sha256="0" * 64),
    lambda v: v.update(occurrence_budget_reached=True),
    lambda v: v["source_ids"].reverse(),
    lambda v: v["groups"].reverse(),
    lambda v: v["groups"][0].update(state="single_leading"),
    lambda v: v["groups"][0].update(leading_count=1),
    lambda v: v["groups"][0]["sides"][1]["inline"][0].update(start_utf16=6),
    lambda v: v["groups"][0]["sides"][1]["inline"][0].update(ordinal=True),
    lambda v: v["document_coverage"][1].update(missing_pages=[]),
])
def test_tampering_rejects(artifacts, change):
    snapshot, report = artifacts
    change(report)
    with pytest.raises(audit.AuditError):
        reference.audit_reference_index(audit.encode_audit(report), snapshot)


def test_cli_rejects_overwrite_and_mismatch(artifacts, tmp_path):
    snapshot, report = artifacts
    first, second = tmp_path / "references.json", tmp_path / "snapshot.json"
    output = tmp_path / "audit.json"
    first.write_bytes(audit.encode_audit(report))
    second.write_bytes(snapshot)
    args = [str(first), str(second), "--output", str(output)]
    assert cli.main(args) == 0
    saved = output.read_bytes()
    assert json.loads(saved)["groups"] == 3
    assert cli.main(args) == 2
    assert output.read_bytes() == saved
    output.unlink()
    first.write_bytes(b"{}")
    assert cli.main(args) == 2
    assert not output.exists()
