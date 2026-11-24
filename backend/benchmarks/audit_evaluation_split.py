"""Audit byte-level isolation between development and held-out evaluation PDFs.

This reads pinned manifests and verifies their PDF hashes without extracting
text, calling a model, or scoring labels. It cannot establish semantic novelty.
"""

import argparse
import json
from collections import defaultdict
from pathlib import Path

from evaluate_labeled import _manifest, _pdf


def _inventory(manifest: Path) -> tuple[dict, dict, str, dict, int]:
    resolved = manifest.resolve()
    version, cases, digest = _manifest(resolved)
    if version != 2:
        raise ValueError("Split auditing requires version-2 SHA-pinned manifests")
    documents = defaultdict(set)
    pairs = defaultdict(list)
    groups = defaultdict(set)
    ungrouped = 0
    for case in cases:
        if "issuer_group" in case and "event_group" in case:
            group = (case["issuer_group"].casefold(), case["event_group"].casefold())
            groups[group].add(case["id"])
        else:
            ungrouped += 1
        for role in ("original", "revised"):
            sha = case[f"{role}_sha256"]
            _pdf(resolved.parent, case.get(role), sha)
            documents[sha].add(case["id"])
        pair = tuple(sorted((case["original_sha256"], case["revised_sha256"])))
        pairs[pair].append(case["id"])
    return dict(documents), dict(pairs), digest, dict(groups), ungrouped


def _summary(documents: dict, pairs: dict, digest: str) -> dict:
    return {
        "manifest_sha256": digest,
        "case_count": sum(len(ids) for ids in pairs.values()),
        "distinct_document_count": len(documents),
        "distinct_pair_count": len(pairs),
        "repeated_pair_groups": [
            sorted(ids) for _, ids in sorted(pairs.items()) if len(ids) > 1
        ],
    }


def audit_split(
    development: Path, heldout: Path, *, require_event_groups: bool = False,
) -> dict:
    """Report exact shared document bytes, including swapped document roles."""
    if development.resolve() == heldout.resolve():
        raise ValueError("Development and held-out manifests must be separate files")
    dev_docs, dev_pairs, dev_sha, dev_groups, dev_ungrouped = _inventory(development)
    test_docs, test_pairs, test_sha, test_groups, test_ungrouped = _inventory(heldout)
    shared_groups = dev_groups.keys() & test_groups.keys()
    shared_docs = dev_docs.keys() & test_docs.keys()
    shared_pairs = dev_pairs.keys() & test_pairs.keys()
    dev = _summary(dev_docs, dev_pairs, dev_sha)
    test = _summary(test_docs, test_pairs, test_sha)
    return {
        "development": dev,
        "heldout": test,
        "shared_document_count": len(shared_docs),
        "shared_pair_count": len(shared_pairs),
        "shared_declared_event_group_count": len(shared_groups),
        "development_ungrouped_cases": dev_ungrouped,
        "heldout_ungrouped_cases": test_ungrouped,
        "overlapping_declared_event_groups": [
            {
                "issuer_group": issuer,
                "event_group": event,
                "development_case_ids": sorted(dev_groups[issuer, event]),
                "heldout_case_ids": sorted(test_groups[issuer, event]),
            }
            for issuer, event in sorted(shared_groups)
        ],
        "overlapping_documents": [
            {
                "sha256": sha,
                "development_case_ids": sorted(dev_docs[sha]),
                "heldout_case_ids": sorted(test_docs[sha]),
            }
            for sha in sorted(shared_docs)
        ],
        "passed": not (
            shared_docs or shared_groups
            or dev["repeated_pair_groups"] or test["repeated_pair_groups"]
            or (require_event_groups and (dev_ungrouped or test_ungrouped))
        ),
        "note": (
            "Checks exact bytes and operator-declared event groups only. "
            "Manually audit near-duplicates and mislabeled or related event families."
        ),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("development", type=Path)
    parser.add_argument("heldout", type=Path)
    parser.add_argument("--require-event-groups", action="store_true")
    args = parser.parse_args(argv)
    try:
        report = audit_split(
            args.development, args.heldout, require_event_groups=args.require_event_groups,
        )
    except (OSError, ValueError, KeyError, RecursionError) as exc:
        parser.error(str(exc))
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
