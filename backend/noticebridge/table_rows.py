"""Keep native date, fee and schedule cells with labels in simple ruled tables."""

import math
import re
from collections import Counter, defaultdict
from itertools import pairwise

import pymupdf as fitz

from .classification import category_for, normalize
from .facts import (
    AMOUNT_TOKEN,
    CLOCK_TOKEN,
    CLOCK_ZONE,
    DATE_TOKEN,
    parse_date,
    single_clock_token,
)
from .models import ExtractedLine

MAX_PAGE_LINES = 512
MAX_DRAWING_ITEMS = 256
# Zone labels remain part of the original context. This is not conversion.
DATE_CLOCK_SEPARATOR = re.compile(r"(?:\s+(?:at\s+)?|,\s*)", re.IGNORECASE)

Interval = tuple[float, float]
Box = tuple[float, float, float, float]
Row = tuple[Box, ...]
REVISION_SUBJECTS = frozenset({
    "activity", "activities", "event", "events", "requirement", "particulars",
    "description", "schedule", "details",
})
EARLIER_DATE_HEADERS = frozenset({
    "earlier date", "earlier dates", "original date", "original dates",
    "existing date", "existing dates", "previous date", "previous dates",
})
REVISED_DATE_HEADERS = frozenset({
    "revised date", "revised dates", "extended date", "extended dates",
    "updated date", "updated dates", "new date", "new dates",
})


def _continuous_rules(rules: dict[float, list[Interval]]) -> dict[float, list[Interval]]:
    """Combine touching strokes so a grid drawn cell by cell is still usable."""
    result: dict[float, list[Interval]] = {}
    for position, spans in sorted(rules.items()):
        merged: list[Interval] = []
        for start, end in sorted(spans):
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
            else:
                merged.append((start, end))
        result[position] = merged
    return result


def _ruled_rows(page: fitz.Page, *, column_count: int = 2) -> set[Row]:
    try:
        paths = page.get_cdrawings()
    except (RuntimeError, ValueError):
        return set()
    if len(paths) > MAX_DRAWING_ITEMS or sum(
        len(path["items"]) for path in paths
    ) > MAX_DRAWING_ITEMS:
        return set()

    horizontal: dict[float, list[Interval]] = defaultdict(list)
    vertical: dict[float, list[Interval]] = defaultdict(list)

    def add_stroke(start: Interval, end: Interval) -> None:
        coordinates = (*start, *end)
        if not all(math.isfinite(value) for value in coordinates):
            return
        x0, y0, x1, y1 = (round(value, 2) for value in coordinates)
        if y0 == y1 and x0 != x1:
            horizontal[y0].append((min(x0, x1), max(x0, x1)))
        elif x0 == x1 and y0 != y1:
            vertical[x0].append((min(y0, y1), max(y0, y1)))

    for path in paths:
        if (
            path["type"] not in ("s", "fs")
            or path.get("stroke_opacity", 0) <= 0
            or path.get("layer")
        ):
            continue
        for item in path["items"]:
            if item[0] == "l":
                add_stroke(item[1], item[2])
            elif item[0] == "re":
                left, top, right, bottom = item[1]
                corners = [(left, top), (right, top), (right, bottom), (left, bottom),
                           (left, top)]
                for start, end in pairwise(corners):
                    add_stroke(start, end)

    horizontal = _continuous_rules(horizontal)
    vertical = _continuous_rules(vertical)
    boundaries: dict[Interval, list[float]] = defaultdict(list)
    for y, spans in horizontal.items():
        for span in spans:
            boundaries[span].append(y)

    rows: set[Row] = set()
    for (left, right), positions in boundaries.items():
        previous: Row | None = None
        for top, bottom in pairwise(positions):
            # Any interior cross-rule indicates a divided or ambiguous cell.
            if any(
                a < right and left < b
                for y, spans in horizontal.items() if top < y < bottom
                for a, b in spans
            ):
                previous = None
                continue
            columns = [
                (x, spans) for x, spans in vertical.items() if left <= x <= right
                and any(a < bottom and top < b for a, b in spans)
            ]
            if (
                len(columns) != column_count + 1
                or (columns[0][0], columns[-1][0]) != (left, right)
                or any(not any(a <= top and bottom <= b for a, b in spans)
                       for _, spans in columns)
            ):
                previous = None
                continue
            row = tuple(
                (a[0], top, b[0], bottom) for a, b in pairwise(columns)
            )
            # Adjacent rows must have identical column boundaries.
            if previous is not None and tuple(cell[2] for cell in previous) == tuple(
                cell[2] for cell in row
            ):
                rows.update((previous, row))
            previous = row
    return rows


def _contains(cell: Box, quote: Box) -> bool:
    return (
        cell[0] <= quote[0] < quote[2] <= cell[2]
        and cell[1] <= quote[1] < quote[3] <= cell[3]
    )


def _schedule_value(text: str) -> bool:
    """Accept only a complete clock cell or a single full date plus clock.

    A clock hidden in prose, range, identifier, or bare UTC offset is not a
    standalone table value. Preserve unsupported cells as individual lines.
    """
    clock = single_clock_token(text)
    if clock is None or CLOCK_ZONE.fullmatch(text[clock.end():]) is None:
        return False
    prefix = text[:clock.start()]
    if not prefix.strip():
        return True
    date_match = DATE_TOKEN.match(prefix)
    return bool(
        date_match
        and parse_date(date_match[0]).canonical is not None
        and DATE_CLOCK_SEPARATOR.fullmatch(prefix[date_match.end():])
    )


def _cell_lines(row: Row, lines: list[ExtractedLine]) -> tuple[int, ...] | None:
    """Exactly one contained native line per cell; reject extra crossing text."""
    candidates = [
        (index, box)
        for index, line in enumerate(lines)
        if (box := line.evidence.bbox)[0] < row[-1][2] and row[0][0] < box[2]
        and box[1] < row[0][3] and row[0][1] < box[3]
    ]
    if len(candidates) != len(row):
        return None
    ordered = sorted(candidates, key=lambda entry: entry[1][0])
    if not all(_contains(cell, box) for cell, (_, box) in zip(row, ordered, strict=True)):
        return None
    return tuple(index for index, _ in ordered)


def _revision_date_rows(page: fitz.Page, lines: list[ExtractedLine]) -> list[tuple[int, ...]]:
    """Preserve both printed date columns only below explicit native headings.

    This is evidence grouping, not interpretation of which date governs.
    Stop on a gap, unsupported row or changed header; never infer from position alone.
    """
    grids: dict[tuple[float, ...], list[Row]] = defaultdict(list)
    for row in _ruled_rows(page, column_count=3):
        grids[(row[0][0], *(cell[2] for cell in row))].append(row)
    result = []
    for rows in grids.values():
        previous_bottom = None
        active = False
        for row in sorted(rows, key=lambda cells: cells[0][1]):
            if previous_bottom != row[0][1]:
                active = False
            previous_bottom = row[0][3]
            indices = _cell_lines(row, lines)
            if indices is None:
                active = False
                continue
            label, earlier, revised = (lines[index].text for index in indices)
            if (
                normalize(label) in REVISION_SUBJECTS
                and normalize(earlier) in EARLIER_DATE_HEADERS
                and normalize(revised) in REVISED_DATE_HEADERS
            ):
                active = True
                continue
            if not active:
                continue
            if (
                category_for(label) != "deadline"
                or DATE_TOKEN.search(label) or AMOUNT_TOKEN.search(label)
                or CLOCK_TOKEN.search(label)
                or not DATE_TOKEN.fullmatch(earlier) or not DATE_TOKEN.fullmatch(revised)
                or parse_date(earlier).canonical is None
                or parse_date(revised).canonical is None
            ):
                active = False
                continue
            result.append(indices)
    return result


def join_ruled_value_rows(
    page: fitz.Page, lines: list[ExtractedLine], *, max_quote_length: int,
    warnings: list[str] | None = None,
) -> list[ExtractedLine]:
    """Reuse native quotes only when their bounding boxes fit two proven cells."""
    if not 2 <= len(lines) <= MAX_PAGE_LINES:
        return lines
    ordinary_values = {
        index for index, line in enumerate(lines)
        if DATE_TOKEN.fullmatch(line.text) or AMOUNT_TOKEN.fullmatch(line.text)
    }
    schedules = {
        index for index, line in enumerate(lines)
        if index not in ordinary_values and _schedule_value(line.text)
    }
    values = ordinary_values | schedules
    if not values or len(values) == len(lines):
        return lines
    pairs: list[tuple[int, ...]] = []
    for left, right in _ruled_rows(page):
        in_row = [
            (index, box)
            for index, line in enumerate(lines)
            if (box := line.evidence.bbox)[0] < right[2] and left[0] < box[2]
            and box[1] < left[3] and left[1] < box[3]
        ]
        if len(in_row) != 2:
            continue
        (first, first_box), (second, second_box) = sorted(in_row, key=lambda entry: entry[1][0])
        if (
            second not in values
            or not _contains(left, first_box)
            or not _contains(right, second_box)
        ):
            continue
        label = lines[first].text
        if second in schedules and (
            category_for(label) not in ("deadline", "time") or CLOCK_TOKEN.search(label)
        ):
            continue
        if (
            len(label) + 1 + len(lines[second].text) <= max_quote_length
            and any(char.isalpha() for char in label)
            and not (DATE_TOKEN.search(label) or AMOUNT_TOKEN.search(label))
        ):
            pairs.append((first, second))

    triples = [
        indices for indices in _revision_date_rows(page, lines)
        if sum(len(lines[index].text) for index in indices) + 2 <= max_quote_length
    ]
    groups = pairs + triples
    if not groups:
        return lines
    counts = Counter(index for group in groups for index in group)
    replacements: dict[int, ExtractedLine] = {}
    consumed: set[int] = set()
    review_rows = False
    for group in groups:
        if any(counts[index] != 1 for index in group):
            continue
        members = [lines[index] for index in group]
        boxes = [member.evidence.bbox for member in members]
        text = " ".join(member.text for member in members)
        evidence = members[0].evidence.model_copy(update={
            "text": text,
            "bbox": (min(box[0] for box in boxes), min(box[1] for box in boxes),
                     max(box[2] for box in boxes), max(box[3] for box in boxes)),
        })
        # No synthesized connector or discarded date. The joined triple
        # carries review-only status within extraction, not a confirmed delta.
        review_only = len(group) == 3
        replacements[min(group)] = ExtractedLine(
            text=text, evidence=evidence, review_only=review_only,
        )
        consumed.update(set(group) - {min(group)})
        review_rows |= review_only
    if review_rows and warnings is not None:
        source = lines[0].evidence
        warnings.append(
            f"{source.document_id}: page {source.page} contains an earlier/revised date table; "
            "both printed values are retained, verify the column headings"
        )
    return [replacements.get(index, line) for index, line in enumerate(lines)
            if index not in consumed]
