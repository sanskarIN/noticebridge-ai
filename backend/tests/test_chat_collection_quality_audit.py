"""Independent quality recomputation including Unicode and page boundaries."""
import json

import pytest

from noticebridge import chat_collection_audit as audit
from noticebridge import chat_collection_quality_audit as quality
from noticebridge import chat_collection_quality_audit_cli as cli


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def source(source_id, lines, processed, physical):
    passages = [
        {
            "role": "original",
            "page": page,
            "ordinal": ordinal,
            "text": text,
            **({"position": {"x0": 1, "x1": 50, "y": 40, "height": 8}}
               if geometry else {}),
        }
        for page, ordinal, text, geometry in lines
    ]
    return {
        "format": "noticebridge-native-corpus-snapshot",
        "version": 1,
        "policy": audit.NATIVE_POLICY,
        "authority_verified": False,
        "sources": [{
            "role": "original",
            "sha256": source_id,
            "page_count": physical,
            "processed_pages": processed,
            "missing_pages": [
                page for page in range(1, processed + 1)
                if not any(item["page"] == page for item in passages)
            ],
            "limited_pages": [],
            "limited": physical != processed,
            "passages": passages,
        }],
    }


@pytest.fixture
def artifacts():
    first = "a" * 64
    second = "b" * 64
    raw = encode({
        "format": "noticebridge-collection-native-snapshot",
        "version": 1,
        "policy": audit.SNAPSHOT_POLICY,
        "authority_verified": False,
        "sources": [
            source(first, [
                (1, 1, "Repeated", True),
                (1, 2, "Repeated", True),
                (1, 3, "Private \ufffd", False),
                (2, 1, "Repeated", True),
                (2, 2, "\ue000", True),
                (2, 3, "A\u200dB", True),
                (2, 4, "😀", True),
            ], 3, 1000000),
            source(second, [(1, 1, "Repeated", True)], 1, 1),
        ],
    })
    return raw, quality.recompute_quality(audit.parse_snapshot(raw), [first, second])


def test_quality_counts_and_cross_document_isolation(artifacts):
    snapshot, report = artifacts
    assert report["fragments"] == 8
    assert report["flagged_fragments"] == 7
    assert report["counts"] == {
        "replacement": 1,
        "private_use": 1,
        "control": 1,
        "no_letters_or_digits": 2,
        "missing_geometry": 1,
        "duplicate_on_page": 2,
        "repeated_across_pages": 3,
    }
    first, second = report["sources"]
    assert len(first["pages"]) == 3
    assert first["unprocessed_pages"] == 999997
    assert first["pages"][2]["coverage"] == "no_indexed_text"
    assert second["flagged_fragments"] == 0
    assert first["pages"][1]["flagged"][-1] == {
        "ordinal": 4, "flags": ["no_letters_or_digits"],
    }
    verified = quality.audit_quality(encode(report), snapshot)
    assert verified["diagnostics_recomputed"] is True
    assert verified["native_extraction_replayed"] is False
    assert verified["unicode_database_version"]
    assert b"Repeated" not in encode(verified)


@pytest.mark.parametrize(("text", "flags"), [
    ("123", []),
    ("é", []),
    ("नमस्ते", []),
    ("Ⅳ", []),
    ("\ufffd\ufffd", ["replacement", "no_letters_or_digits"]),
    ("abc\tdef", []),
    ("abc\u200ddef", ["control"]),
    ("\U000f0000", ["private_use", "no_letters_or_digits"]),
    ("😀", ["no_letters_or_digits"]),
])
def test_categories(text, flags):
    assert quality.character_flags(text) == flags
    assert quality.utf16_units(text) == len(text.encode("utf-16-le")) // 2


@pytest.mark.parametrize("change", [
    lambda v: v.update(authority_verified=True),
    lambda v: v.update(pdf_bytes_verified=True),
    lambda v: v.update(extraction_completeness_verified=True),
    lambda v: v.update(snapshot_sha256="0" * 64),
    lambda v: v.update(fragments=True),
    lambda v: v.update(flagged_fragments=999),
    lambda v: v["counts"].update(replacement=0),
    lambda v: v["source_ids"].append(v["source_ids"][0]),
    lambda v: v["sources"].reverse(),
    lambda v: v["sources"][0].update(unprocessed_pages=0),
    lambda v: v["sources"][0]["pages"][0].update(coverage="limited"),
    lambda v: v["sources"][0]["pages"][0]["flagged"][0].update(ordinal=999),
    lambda v: v["sources"][0]["pages"][0]["flagged"][0]["flags"].reverse(),
    lambda v: v.update(extra=True),
])
def test_quality_report_tampering_rejects(artifacts, change):
    snapshot, report = artifacts
    change(report)
    with pytest.raises(audit.AuditError):
        quality.audit_quality(encode(report), snapshot)


def test_cli_never_overwrites(artifacts, tmp_path):
    snapshot, report = artifacts
    report_path = tmp_path / "quality.json"
    snapshot_path = tmp_path / "snapshot.json"
    output = tmp_path / "audit.json"
    report_path.write_bytes(encode(report))
    snapshot_path.write_bytes(snapshot)
    args = [str(report_path), str(snapshot_path), "--output", str(output)]
    assert cli.main(args) == 0
    saved = output.read_bytes()
    assert cli.main(args) == 2
    assert output.read_bytes() == saved
    output.unlink()
    report_path.write_bytes(b"{}")
    assert cli.main(args) == 2
    assert not output.exists()
