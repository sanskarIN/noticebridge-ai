"""Prevent accidental exact document leakage between evaluation splits."""

import hashlib
import json
import sys
from pathlib import Path

import pytest

BENCHMARKS = Path(__file__).resolve().parents[1] / "benchmarks"
sys.path.insert(0, str(BENCHMARKS))
from audit_evaluation_split import audit_split, main  # noqa: E402


@pytest.fixture
def manifests(tmp_path, pdf_bytes):
    content = {
        key: pdf_bytes([[f"Fictional private excerpt {key}"]]) for key in "abcd"
    }

    def create(name, specs):
        root = tmp_path / name
        root.mkdir(exist_ok=True)
        cases = []
        for case_id, old, new in specs:
            case = {
                "id": case_id, "source_kind": "fictional", "label_method": "author_reviewed",
                "expected_pairs": [],
            }
            for role, key in (("original", old), ("revised", new)):
                # Each role has a separate filename; fingerprints identify reuse.
                filename = f"{case_id}-{role}.pdf"
                (root / filename).write_bytes(content[key])
                case[role] = filename
                case[f"{role}_sha256"] = hashlib.sha256(content[key]).hexdigest()
            cases.append(case)
        path = root / "labels.json"
        path.write_text(json.dumps({"version": 2, "cases": cases}), encoding="utf-8")
        return path

    return create


def test_disjoint_splits_pass_without_exposing_quotes(manifests, capsys):
    dev = manifests("dev", [("dev-1", "a", "b")])
    test = manifests("test", [("test-1", "c", "d")])
    assert main([str(dev), str(test)]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["passed"]
    assert report["shared_document_count"] == report["shared_pair_count"] == 0
    assert report["development"]["distinct_document_count"] == 2
    assert "Fictional private excerpt" not in json.dumps(report)


@pytest.mark.parametrize(("old", "new", "shared_docs", "shared_pairs"), [
    ("c", "a", 1, 0), ("b", "c", 1, 0), ("b", "a", 2, 1), ("a", "b", 2, 1),
])
def test_cross_split_reuse_detected_even_under_renaming_and_role_swap(
    manifests, capsys, old, new, shared_docs, shared_pairs,
):
    dev = manifests("dev", [("dev-1", "a", "b")])
    test = manifests("test", [("test-1", old, new)])
    assert main([str(dev), str(test)]) == 1
    report = json.loads(capsys.readouterr().out)
    assert not report["passed"]
    assert report["shared_document_count"] == shared_docs
    assert report["shared_pair_count"] == shared_pairs
    assert len(report["overlapping_documents"]) == shared_docs
    assert all(
        entry["development_case_ids"] == ["dev-1"] and entry["heldout_case_ids"] == ["test-1"]
        for entry in report["overlapping_documents"]
    )


@pytest.mark.parametrize("duplicate_split", ["dev", "test"])
def test_repeated_pairs_within_either_split_are_not_independent_samples(
    manifests, duplicate_split,
):
    dev_specs = [("dev-1", "a", "b")]
    test_specs = [("test-1", "c", "d")]
    if duplicate_split == "dev":
        dev_specs.append(("dev-2", "b", "a"))
    else:
        test_specs.append(("test-2", "d", "c"))
    report = audit_split(manifests("dev", dev_specs), manifests("test", test_specs))
    assert not report["passed"]
    assert report["shared_document_count"] == 0
    split = "development" if duplicate_split == "dev" else "heldout"
    assert len(report[split]["repeated_pair_groups"]) == 1


def test_shared_document_within_one_split_is_allowed_for_distinct_notice_pairs(manifests):
    dev = manifests("dev", [("dev-1", "a", "b"), ("dev-2", "b", "b")])
    test = manifests("test", [("test-1", "c", "d")])
    report = audit_split(dev, test)
    assert report["passed"]
    assert report["development"]["distinct_document_count"] == 2
    assert report["development"]["distinct_pair_count"] == 2


@pytest.mark.parametrize("mutation", ["legacy", "changed_pdf", "same_manifest"])
def test_audit_rejects_unpinned_stale_or_identical_manifests(manifests, mutation):
    dev = manifests("dev", [("dev-1", "a", "b")])
    test = manifests("test", [("test-1", "c", "d")])
    if mutation == "legacy":
        payload = json.loads(test.read_bytes())
        payload["version"] = 1
        test.write_text(json.dumps(payload), encoding="utf-8")
    elif mutation == "changed_pdf":
        (test.parent / "test-1-original.pdf").write_bytes(b"%PDF-1.4\n")
    else:
        test = dev
    with pytest.raises(ValueError):
        audit_split(dev, test)
