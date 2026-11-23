"""Freeze source byte fingerprints for a separately reviewed PDF evaluation corpus.

This converts an existing version-1 manifest to version 2. It does not create,
review, verify or change any labels. Operator declarations of label provenance
are self-reported, never a certification by NoticeBridge AI.
"""

import argparse
import hashlib
import json
from pathlib import Path

from evaluate_labeled import LABEL_METHODS, SOURCE_KINDS, _manifest, _pdf


def pin_dataset(
    manifest: Path,
    *,
    output: Path,
    source_kind: str,
    label_method: str,
) -> Path:
    """Create a non-overwriting v2 manifest with byte-pinned PDF pairs."""
    if source_kind not in SOURCE_KINDS or label_method not in LABEL_METHODS:
        raise ValueError("Source category and label method must be explicitly declared")
    source = manifest.resolve()
    version, cases, _ = _manifest(source)
    if version != 1:
        raise ValueError("Only a version-1 manifest can be upgraded")
    output_path = output.resolve()
    root = source.parent
    if output_path == source or output_path.parent != root:
        raise ValueError("Output must be a new JSON file in the manifest folder")
    if output_path.suffix.lower() != ".json":
        raise ValueError("Output must be a JSON file")
    pinned_cases = []
    for case in cases:
        old = _pdf(root, case["original"])
        new = _pdf(root, case["revised"])
        pinned_cases.append({
            **case,
            "original_sha256": hashlib.sha256(old).hexdigest(),
            "revised_sha256": hashlib.sha256(new).hexdigest(),
            "source_kind": source_kind,
            "label_method": label_method,
        })
    payload = {"version": 2, "cases": pinned_cases}
    # Atomic exclusive creation prevents overwriting existing labels. The
    # corpus is operator-owned; no PDF contents or labels are uploaded.
    with output_path.open("x", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    return output_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="Existing version-1 labels.json")
    parser.add_argument(
        "--output", type=Path, default=None,
        help="New file next to the manifest; defaults to labels-pinned.json",
    )
    parser.add_argument("--source-kind", required=True, choices=sorted(SOURCE_KINDS))
    parser.add_argument("--label-method", required=True, choices=sorted(LABEL_METHODS))
    args = parser.parse_args()
    output = args.output or args.manifest.with_name(
        args.manifest.stem + "-pinned.json"
    )
    try:
        path = pin_dataset(
            args.manifest, output=output,
            source_kind=args.source_kind, label_method=args.label_method,
        )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    print(f"Pinned input PDFs in {path.name}; labels unchanged and not verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
