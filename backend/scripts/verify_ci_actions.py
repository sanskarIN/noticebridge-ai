"""Fail CI if any workflow action is mutable, unreviewed or unpinned.

The pin allowlist is intentionally explicit: a new action or updated version
requires a reviewed upstream tag-to-commit mapping and a code change here.
This checks standard line-based "uses:" declarations, including named steps;
it is not a general-purpose YAML parser or a security audit of action source code.
"""

import re
from collections import Counter
from pathlib import Path

# Source: refs/tags/<version> in each official actions/* GitHub repository,
# inspected on 2026-11-24. Never use floating tags in the workflow.
APPROVED_ACTIONS = {
    "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",  # v7.0.1
    "actions/setup-python": "6d4fd22b20465ccc0f7354476588e8df7c9ca0e0",  # v7.1.0
    "actions/setup-node": "949feb2413d6458794dcd2491c4babbbce0c15c1",  # v7.1.0
    "actions/upload-artifact": "cf430e030ddbb5b0abf93d22962f4752f3646cd9",  # v7.0.2
}
USES_LINE = re.compile(r"^\s*(?:-\s*)?uses\s*:\s*(\S+)(?:\s+#.*)?$")
USES_START = re.compile(r"^\s*(?:-\s*)?uses\s*:")
PINNED_REF = re.compile(r"^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)@([0-9a-f]{40})$")


def check_workflows(root: Path) -> dict[str, int]:
    """Validate all repository workflows, including newly added ones."""
    directory = root / ".github" / "workflows"
    sources = sorted(set(directory.glob("*.yml")) | set(directory.glob("*.yaml")))
    if not sources:
        raise ValueError("No GitHub Actions workflows found")
    counts: Counter[str] = Counter()
    for path in sources:
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not USES_START.match(line):
                continue
            location = f"{path.name}:{number}"
            matched = USES_LINE.fullmatch(line)
            if matched is None:
                raise ValueError(f"{location}: unsupported or multiline action reference")
            action = PINNED_REF.fullmatch(matched.group(1))
            if action is None:
                raise ValueError(f"{location}: action must use a full lowercase commit SHA")
            name, sha = action.groups()
            if name not in APPROVED_ACTIONS:
                raise ValueError(f"{location}: unreviewed GitHub Action: {name}")
            if sha != APPROVED_ACTIONS[name]:
                raise ValueError(f"{location}: SHA differs from the reviewed {name} pin")
            counts[name] += 1

    missing = APPROVED_ACTIONS.keys() - counts.keys()
    if missing:
        raise ValueError("Missing reviewed actions: " + ", ".join(sorted(missing)))
    return dict(counts)


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    result = check_workflows(root)
    print(f"Verified {sum(result.values())} SHA-pinned action uses in CI")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
