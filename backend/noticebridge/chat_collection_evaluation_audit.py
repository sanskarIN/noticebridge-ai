"""Independent collection evaluation arithmetic and source-reference audit.

The browser's ranker is not reimplemented here. This checks the supplied
label coordinates, recorded retrieval coordinates, coverage and metrics.
It cannot establish that the recorded retrieval was actually executed.
"""

import json
from dataclasses import dataclass

from .chat_collection_audit import (
    Fragment,
    NativeSource,
    Snapshot,
    boolean,
    decode,
    digest,
    hash_string,
    header,
    invalid,
    obj,
    parse_snapshot,
    question_page,
    sequence,
    source_set,
    strict_equal,
    string,
)

MAX_EVALUATION_BYTES = 512 * 1024
MAX_CASES = 64
MAX_EXPECTED = 24
MAX_RETRIEVED = 6
LABEL_POLICY = (
    "Human-labelled native retrieval targets; agreement is not answer truth, "
    "completeness or authority."
)
VARIANT_POLICY = (
    "Paired retrieval against user-supplied labels and explicitly asserted "
    "equivalent question intent."
)
OUTCOMES = ("improved", "regressed", "tradeoff", "unchanged")


@dataclass(frozen=True)
class Label:
    document_id: str
    question: str
    include_context: bool
    expected: tuple[Fragment, ...]
    label: str
    page: int | None

    @property
    def key(self) -> str:
        # JavaScript JSON.stringify array representation; no whitespace.
        return json.dumps(
            [self.document_id, self.question, self.include_context],
            ensure_ascii=False, separators=(",", ":"),
        )


def check_label_text(value, limit: int, *, empty: bool = False, trimmed: bool = False) -> str:
    text = string(value, limit, empty=empty, trimmed=trimmed)
    if any((ord(char) < 32 and char not in "\t\n") or ord(char) == 127 for char in text):
        invalid()
    return text


def coordinate(fragment: Fragment) -> dict:
    return {"page": fragment.page, "ordinal": fragment.ordinal}


def fragment_key(fragment: Fragment) -> tuple[int, int]:
    return fragment.page, fragment.ordinal


def parse_labels(raw: bytes, snapshot: Snapshot) -> list[Label]:
    labels = obj(decode(raw, MAX_EVALUATION_BYTES),
                 "format version policy authority_verified source_ids cases")
    header(labels, "noticebridge-collection-retrieval-labels", LABEL_POLICY)
    source_set(labels["source_ids"], snapshot)
    result = []
    seen = set()
    for value in sequence(labels["cases"], MAX_CASES, minimum=1):
        row = obj(value, "document_id question include_context label note expected")
        source_id = hash_string(row["document_id"])
        source = snapshot.sources.get(source_id)
        if source is None:
            invalid()
        question = check_label_text(row["question"], 400, trimmed=True)
        context = boolean(row["include_context"])
        check_label_text(row["note"], 300, empty=True)
        page = question_page(question)
        label = row["label"]
        if label not in ("evidence", "no_expected_match"):
            invalid()
        expected = []
        previous = (0, 0)
        for item in sequence(row["expected"], MAX_EXPECTED):
            reference = obj(item, "page ordinal text_sha256")
            fragment = source.source_at(reference["page"], reference["ordinal"])
            key = fragment_key(fragment)
            if (key <= previous or page is not None and fragment.page != page
                    or hash_string(reference["text_sha256"]) != fragment.text_sha256):
                invalid()
            previous = key
            expected.append(fragment)
        if bool(expected) != (label == "evidence"):
            invalid()
        target = Label(source_id, question, context, tuple(expected), label, page)
        if target.key in seen:
            invalid()
        seen.add(target.key)
        result.append(target)
    return result


def retrieved_fragments(
    raw, source: NativeSource, page: int | None, context: bool,
) -> tuple[Fragment, ...]:
    rows = []
    seen = set()
    # Strict answers display up to four fragments; nearby-line answers can
    # display up to six. The report alone cannot identify the exact channel.
    for item in sequence(raw, MAX_RETRIEVED if context else 4):
        row = obj(item, "page ordinal")
        fragment = source.source_at(row["page"], row["ordinal"])
        key = fragment_key(fragment)
        if key in seen or page is not None and fragment.page != page:
            invalid()
        seen.add(key)
        rows.append(fragment)
    return tuple(rows)


def ratio(numerator: int | float, denominator: int) -> int | float | None:
    if not denominator:
        return None
    value = numerator / denominator
    # JSON.stringify renders integer-valued numbers without a decimal.
    return int(value) if value.is_integer() else value


@dataclass(frozen=True)
class Observation:
    label: Label
    coverage: str
    retrieved: tuple[Fragment, ...]
    found: tuple[Fragment, ...]
    missed: tuple[Fragment, ...]
    unexpected: tuple[Fragment, ...]
    precision: int | float | None
    recall: int | float | None
    reciprocal_rank: int | float | None
    outcome: str

    def evaluation_wire(self) -> dict:
        return {
            "case_key": self.label.key,
            "coverage": self.coverage,
            "outcome": self.outcome,
            "expected_count": len(self.label.expected),
            "retrieved_count": len(self.retrieved),
            "correct_count": len(self.found),
            "retrieved": [coordinate(row) for row in self.retrieved],
            "precision": self.precision,
            "recall": self.recall,
            "reciprocal_rank": self.reciprocal_rank,
        }

    def variant_wire(self) -> dict:
        return {
            "coverage": self.coverage,
            "outcome": self.outcome,
            "retrieved": [coordinate(row) for row in self.retrieved],
            "expected_found": [coordinate(row) for row in self.found],
            "expected_missed": [coordinate(row) for row in self.missed],
            "unexpected": [coordinate(row) for row in self.unexpected],
            "precision": self.precision,
            "recall": self.recall,
            "reciprocal_rank": self.reciprocal_rank,
        }


def score(
    label: Label, source: NativeSource, raw, *, alternative_context: bool | None = None,
) -> Observation:
    context = label.include_context if alternative_context is None else alternative_context
    retrieved = retrieved_fragments(raw, source, label.page, context)
    expected = {fragment_key(row) for row in label.expected}
    returned = {fragment_key(row) for row in retrieved}
    found = tuple(row for row in label.expected if fragment_key(row) in returned)
    missed = tuple(row for row in label.expected if fragment_key(row) not in returned)
    unexpected = tuple(row for row in retrieved if fragment_key(row) not in expected)
    first = next((i for i, row in enumerate(retrieved, 1) if fragment_key(row) in expected), None)
    if not expected:
        outcome = "unexpected_match" if retrieved else "expected_abstention"
    elif len(found) == len(expected):
        outcome = "all_expected"
    else:
        outcome = "some_expected" if found else "no_expected_retrieved"
    return Observation(
        label=label, coverage=source.coverage(label.page, answer=True), retrieved=retrieved,
        found=found, missed=missed, unexpected=unexpected,
        precision=ratio(len(found), len(retrieved)), recall=ratio(len(found), len(expected)),
        reciprocal_rank=(ratio(1, first) if first else 0) if expected else None,
        outcome=outcome,
    )


def summarize(rows: list[Observation]) -> dict:
    expected = sum(len(row.label.expected) for row in rows)
    retrieved = sum(len(row.retrieved) for row in rows)
    correct = sum(len(row.found) for row in rows)
    evidence = [row for row in rows if row.label.label == "evidence"]
    abstentions = [row for row in rows if row.label.label == "no_expected_match"]
    # Use left-to-right IEEE-754 accumulation, matching the browser reduce
    # rather than Python 3.12's compensated floating-point sum.
    rank_sum = 0.0
    for row in evidence:
        rank_sum += row.reciprocal_rank or 0
    return {
        "cases": len(rows),
        "evidenceCases": len(evidence),
        "abstentionCases": len(abstentions),
        "expectedFragments": expected,
        "retrievedFragments": retrieved,
        "correctFragments": correct,
        "microPrecision": ratio(correct, retrieved),
        "microRecall": ratio(correct, expected),
        "meanReciprocalRank": ratio(rank_sum, len(evidence)),
        "exactCoverageCases": sum(row.outcome == "all_expected" for row in evidence),
        "correctAbstentions": sum(row.outcome == "expected_abstention" for row in abstentions),
        "unexpectedMatches": sum(row.outcome == "unexpected_match" for row in abstentions),
        "incompleteCoverageCases": sum(row.coverage != "some_text" for row in rows),
    }


def audit_evaluation_report(report: dict, labels: list[Label], snapshot: Snapshot) -> dict:
    row = obj(
        report, "format version policy authority_verified labels_sha256 metrics observations",
    )
    header(row, "noticebridge-collection-retrieval-evaluation", LABEL_POLICY)
    observations = sequence(row["observations"], MAX_CASES, minimum=1)
    if len(observations) != len(labels):
        invalid()
    scored = []
    for value, label in zip(observations, labels, strict=True):
        current = obj(
            value, "case_key coverage outcome expected_count retrieved_count "
            "correct_count retrieved precision recall reciprocal_rank",
        )
        observed = score(label, snapshot.sources[label.document_id], current["retrieved"])
        if not strict_equal(current, observed.evaluation_wire()):
            invalid()
        scored.append(observed)
    metrics = summarize(scored)
    if not strict_equal(row["metrics"], metrics):
        invalid()
    return {"metrics": metrics}


def difference(left: tuple[Fragment, ...], right: tuple[Fragment, ...]) -> tuple[Fragment, ...]:
    keys = {fragment_key(row) for row in right}
    return tuple(row for row in left if fragment_key(row) not in keys)


def classification(a: Observation, b: Observation) -> str:
    values = (len(b.found) - len(a.found), len(a.unexpected) - len(b.unexpected),
              (b.reciprocal_rank or 0) - (a.reciprocal_rank or 0))
    better = any(value > 0 for value in values)
    worse = any(value < 0 for value in values)
    if better and worse:
        return "tradeoff"
    return "improved" if better else "regressed" if worse else "unchanged"


def audit_variant_report(report: dict, labels: list[Label], snapshot: Snapshot) -> dict:
    row = obj(
        report, "format version policy authority_verified equivalence_verified "
        "labels_sha256 metrics outcomes changed_order cases",
    )
    header(row, "noticebridge-collection-question-variants", VARIANT_POLICY)
    if row["equivalence_verified"] is not False:
        invalid()
    by_key = {label.key: label for label in labels}
    seen = set()
    baselines, alternatives = [], []
    outcomes = dict.fromkeys(OUTCOMES, 0)
    changed_order = 0
    for value in sequence(row["cases"], 24, minimum=1):
        case = obj(
            value, "case_key alternative_question alternative_context equivalence_confirmed "
            "outcome baseline alternative shared added removed expected_added expected_removed",
        )
        key = string(case["case_key"], 1400)
        label = by_key.get(key)
        if label is None or key in seen or case["equivalence_confirmed"] is not True:
            invalid()
        seen.add(key)
        question = check_label_text(case["alternative_question"], 400, trimmed=True)
        context = boolean(case["alternative_context"])
        if (question_page(question) != label.page or
                question == label.question and context == label.include_context):
            invalid()
        observation_keys = (
            "coverage outcome retrieved expected_found expected_missed "
            "unexpected precision recall reciprocal_rank"
        )
        a_raw = obj(case["baseline"], observation_keys)
        b_raw = obj(case["alternative"], observation_keys)
        source = snapshot.sources[label.document_id]
        a = score(label, source, a_raw["retrieved"])
        b = score(label, source, b_raw["retrieved"], alternative_context=context)
        if not strict_equal(a_raw, a.variant_wire()) or not strict_equal(b_raw, b.variant_wire()):
            invalid()
        removed = difference(a.retrieved, b.retrieved)
        added = difference(b.retrieved, a.retrieved)
        shared = tuple(item for item in a.retrieved if item not in removed)
        expected_added = difference(b.found, a.found)
        expected_removed = difference(a.found, b.found)
        outcome = classification(a, b)
        if case["outcome"] != outcome:
            invalid()
        for name, fragments in (
            ("shared", shared), ("added", added), ("removed", removed),
            ("expected_added", expected_added), ("expected_removed", expected_removed),
        ):
            if not strict_equal(case[name], [coordinate(item) for item in fragments]):
                invalid()
        outcomes[outcome] += 1
        if not added and not removed and a.retrieved != b.retrieved:
            changed_order += 1
        baselines.append(a)
        alternatives.append(b)
    metrics = {"baseline": summarize(baselines), "alternative": summarize(alternatives)}
    if (not strict_equal(row["metrics"], metrics) or not strict_equal(row["outcomes"], outcomes)
            or not strict_equal(row["changed_order"], changed_order)):
        invalid()
    return {"metrics": metrics, "outcomes": outcomes, "changed_order": changed_order}


def audit_evaluation(report_raw: bytes, labels_raw: bytes, snapshot_raw: bytes) -> dict:
    snapshot = parse_snapshot(snapshot_raw)
    labels = parse_labels(labels_raw, snapshot)
    report = decode(report_raw, MAX_EVALUATION_BYTES)
    if hash_string(report.get("labels_sha256")) != digest(labels_raw):
        invalid()
    kind = report.get("format")
    if kind == "noticebridge-collection-retrieval-evaluation":
        result = audit_evaluation_report(report, labels, snapshot)
    elif kind == "noticebridge-collection-question-variants":
        result = audit_variant_report(report, labels, snapshot)
    else:
        invalid()
    return {
        "format": "noticebridge-collection-evaluation-audit",
        "version": 1,
        "policy": "Independent metric and coordinate consistency audit of recorded retrieval.",
        "authority_verified": False,
        "answer_accuracy_verified": False,
        "equivalence_verified": False,
        "retrieval_replayed": False,
        "native_extraction_replayed": False,
        "canonical_browser_encoding_verified": False,
        "metrics_recomputed": True,
        "source_coordinates_checked": True,
        "report_format": kind,
        "report_sha256": digest(report_raw),
        "labels_sha256": digest(labels_raw),
        "snapshot_sha256": snapshot.sha256,
        **result,
    }
