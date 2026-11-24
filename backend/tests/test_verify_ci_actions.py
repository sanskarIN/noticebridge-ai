"""Enforce immutable, approved GitHub Action references in every workflow."""

from pathlib import Path
import sys

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from verify_ci_actions import APPROVED_ACTIONS, check_workflows  # noqa: E402


def _workflow(tmp_path, lines):
    directory = tmp_path / ".github" / "workflows"
    directory.mkdir(parents=True)
    file = directory / "ci.yml"
    file.write_text("name: CI\njobs:\n" + "\n".join(lines) + "\n", encoding="utf-8")
    return file


def _approved_lines():
    return [
        f"  - uses: {name}@{sha} # reviewed"
        for name, sha in APPROVED_ACTIONS.items()
    ]


def test_repository_workflows_use_reviewed_immutable_action_commits():
    repo = Path(__file__).resolve().parents[2]
    counts = check_workflows(repo)
    assert set(counts) == set(APPROVED_ACTIONS)
    assert all(count > 0 for count in counts.values())


def test_valid_allowlist_and_version_comments(tmp_path):
    _workflow(tmp_path, _approved_lines())
    assert check_workflows(tmp_path) == {key: 1 for key in APPROVED_ACTIONS}


@pytest.mark.parametrize(("broken", "message"), [
    ("actions/checkout@v7", "full lowercase commit SHA"),
    ("actions/checkout@main", "full lowercase commit SHA"),
    ("actions/checkout@3d3c42e", "full lowercase commit SHA"),
    ("actions/checkout@"+("a" * 40), "differs from the reviewed"),
    ("other/fork@"+("a" * 40), "unreviewed GitHub Action"),
    ("./.github/actions/custom@"+("a" * 40), "full lowercase commit SHA"),
])
def test_floating_modified_and_unreviewed_action_references_fail(
    tmp_path, broken, message,
):
    lines = _approved_lines()
    lines[0] = "  - uses: " + broken
    _workflow(tmp_path, lines)
    with pytest.raises(ValueError, match=message):
        check_workflows(tmp_path)


def test_duplicate_action_references_are_checked(tmp_path):
    lines = _approved_lines()
    lines.append("    - uses: actions/setup-node@v7")
    _workflow(tmp_path, lines)
    with pytest.raises(ValueError, match="full lowercase commit SHA"):
        check_workflows(tmp_path)


def test_multiline_action_reference_fails_closed(tmp_path):
    lines = _approved_lines()
    lines[0] = "  - uses: >-"
    _workflow(tmp_path, lines)
    with pytest.raises(ValueError, match="full lowercase commit SHA"):
        check_workflows(tmp_path)


def test_other_yaml_extension_is_not_ignored(tmp_path):
    _workflow(tmp_path, _approved_lines())
    other = tmp_path / ".github" / "workflows" / "unchecked.yaml"
    other.write_text("steps:\n  - uses: actions/checkout@v7\n", encoding="utf-8")
    with pytest.raises(ValueError, match="full lowercase commit SHA"):
        check_workflows(tmp_path)


def test_no_workflows_fails_closed(tmp_path):
    with pytest.raises(ValueError, match="No GitHub Actions workflows"):
        check_workflows(tmp_path)
