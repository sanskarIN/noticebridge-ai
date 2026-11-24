"""Build a blank pinned source manifest from an operator-collected local PDF register.

No downloads, PDF text extraction, OCR, model inference or labels are performed.
The register is private working metadata; source provenance is not authenticated.
"""

import argparse
import hashlib
import json
from pathlib import Path

from evaluate_labeled import CASE_ID, MAX_CASES, MAX_MANIFEST_BYTES, SOURCE_KINDS
from evaluate_labeled import _pdf, _unique_object

from noticebridge.extract import validate_ocr_pages

REQUIRED = frozenset({
    "id", "source_kind", "issuer_group", "event_group", "original", "revised",
})
OPTIONAL = frozenset({"original_ocr_pages", "revised_ocr_pages"})


def build_sources(register: Path, *, output: Path) -> dict:
    """Check every local file and write a new manifest that cannot be scored yet."""
    source = register.resolve()
    target = output.resolve()
    if target.parent != source.parent or target.suffix.lower() != ".json":
        raise ValueError("Output must be a new JSON file in the register folder")
    if source.stat().st_size > MAX_MANIFEST_BYTES:
        raise ValueError("Source register exceeds the size limit")
    payload = json.loads(source.read_text(encoding="utf-8"), object_pairs_hook=_unique_object)
    if (
        not isinstance(payload, dict) or set(payload) != {"version", "cases"}
        or type(payload["version"]) is not int or payload["version"] != 1
        or not isinstance(payload["cases"], list)
        or not 1 <= len(payload["cases"]) <= MAX_CASES
    ):
        raise ValueError("Source register must contain version 1 and a nonempty bounded cases list")
    ids: set[str] = set()
    pair_keys: set[tuple[str, str]] = set()
    groups: set[tuple[str, str]] = set()
    documents: set[str] = set()
    cases = []
    for record in payload["cases"]:
        if (
            not isinstance(record, dict) or not REQUIRED <= record.keys()
            or not record.keys() <= REQUIRED | OPTIONAL
        ):
            raise ValueError("Register rows must contain only approved source fields")
        for field in ("id", "issuer_group", "event_group"):
            if not isinstance(record[field], str) or not CASE_ID.fullmatch(record[field]):
                raise ValueError(f"Invalid source register {field}")
        case_id = record["id"]
        if case_id in ids:
            raise ValueError(f"Repeated source case ID: {case_id}")
        ids.add(case_id)
        if not isinstance(record["source_kind"], str) or record["source_kind"] not in SOURCE_KINDS:
            raise ValueError(f"{case_id}: invalid source category")
        case = dict(record)
        for role in ("original", "revised"):
            pdf = _pdf(source.parent, record[role])
            if not pdf.startswith(b"%PDF-"):
                raise ValueError(f"{case_id}: {role} lacks a PDF signature")
            digest = hashlib.sha256(pdf).hexdigest()
            documents.add(digest)
            case[f"{role}_sha256"] = digest
            field = f"{role}_ocr_pages"
            if field in case:
                case[field] = list(validate_ocr_pages(case[field]))
        pair = tuple(sorted((case["original_sha256"], case["revised_sha256"])))
        if pair in pair_keys:
            raise ValueError(f"{case_id}: repeated unordered PDF pair")
        pair_keys.add(pair)
        groups.add((case["issuer_group"].casefold(), case["event_group"].casefold()))
        case.update(label_method="unreviewed", review_complete=False, expected_pairs=[])
        cases.append(case)

    encoded = (
        json.dumps({"version": 2, "cases": cases}, indent=2, ensure_ascii=False) + "\n"
    ).encode("utf-8")
    if len(encoded) > MAX_MANIFEST_BYTES:
        raise ValueError("Pinned source manifest exceeds the size limit")
    with target.open("xb") as handle:
        handle.write(encoded)
    return {
        "case_count": len(cases),
        "distinct_document_count": len(documents),
        "declared_event_group_count": len(groups),
        "review_complete": False,
        "note": "Unreviewed source inventory only; no issuer or label authenticity is verified.",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("register", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        report = build_sources(args.register, output=args.output)
    except (OSError, ValueError, KeyError, RecursionError) as exc:
        parser.error(str(exc))
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
