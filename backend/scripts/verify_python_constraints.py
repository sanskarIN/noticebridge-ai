"""Confirm the explicitly constrained Python 3.12 CI environment.

Run after pip install -c backend/constraints-py312.txt -e './backend[dev]'.
A constraint file pins *selected* distributions, not every optional package
installed by the runner. This script does not contact PyPI or external hosts.
"""

import importlib.metadata as metadata
import re
import sys
from pathlib import Path

CONSTRAINTS = Path(__file__).resolve().parents[1] / "constraints-py312.txt"
ENTRY = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.!+_-]*)$")
REQUIRED = {
    "fastapi", "uvicorn", "pydantic", "pymupdf", "python-multipart",
    "httpx", "pytest", "ruff", "starlette", "pydantic-core",
}


def expected_versions(path: Path = CONSTRAINTS) -> dict[str, str]:
    expected: dict[str, str] = {}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = ENTRY.fullmatch(line)
        if match is None:
            raise ValueError(f"Constraint line {number} must pin name==version")
        name = re.sub(r"[-_.]+", "-", match.group(1)).lower()
        if name in expected:
            raise ValueError(f"Duplicate constraint package: {name}")
        expected[name] = match.group(2)
    if not REQUIRED.issubset(expected):
        raise ValueError("Missing critical direct or transitive dependencies")
    return expected


def verify_installed_constraints(expected: dict[str, str] | None = None) -> list[str]:
    versions = expected if expected is not None else expected_versions()
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError("This CI constraint set is verified for Python 3.12 only")
    mismatches = []
    for name, expected_version in versions.items():
        try:
            actual = metadata.version(name)
        except metadata.PackageNotFoundError:
            if name in REQUIRED:
                mismatches.append(f"{name}: not installed (expected {expected_version})")
            continue
        if actual != expected_version:
            mismatches.append(f"{name}: found {actual}, expected {expected_version}")
    return mismatches


def main() -> int:
    versions = expected_versions()
    mismatches = verify_installed_constraints(versions)
    if mismatches:
        for message in mismatches:
            print(message, file=sys.stderr)
        return 1
    print(f"Verified {len(versions)} pinned Python 3.12 package versions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
