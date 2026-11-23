"""Keep native date and fee cells with their labels in simple ruled tables."""

import math
from collections import Counter, defaultdict
from itertools import pairwise

import pymupdf as fitz

from .facts import AMOUNT_TOKEN, DATE_TOKEN
from .models import ExtractedLine

MAX_PAGE_LINES = 512
MAX_DRAWING_ITEMS = 256

Interval = tuple[float, float]
Box = tuple[float, float, float, float]
Row = tuple[Box, Box]


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


def _ruled_rows(page: fitz.Page) -> set[Row]:
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
                len(columns) != 3
                or (columns[0][0], columns[-1][0]) != (left, right)
                or any(not any(a <= top and bottom <= b for a, b in spans)
                       for _, spans in columns)
            ):
                previous = None
                continue
            divider = columns[1][0]
            row = ((left, top, divider, bottom), (divider, top, right, bottom))
            # A second adjacent row with the same columns distinguishes a grid
            # from an isolated pair of decorative boxes.
            if previous is not None and previous[0][2] == divider:
                rows.update((previous, row))
            previous = row
    return rows


def _contains(cell: Box, quote: Box) -> bool:
    return (
        cell[0] <= quote[0] < quote[2] <= cell[2]
        and cell[1] <= quote[1] < quote[3] <= cell[3]
    )


def join_ruled_value_rows(
    page: fitz.Page, lines: list[ExtractedLine], *, max_quote_length: int,
) -> list[ExtractedLine]:
    """Reuse native quotes only when their bounding boxes fit two proven cells."""
    if not 2 <= len(lines) <= MAX_PAGE_LINES:
        return lines
    values = {
        index for index, line in enumerate(lines)
        if DATE_TOKEN.fullmatch(line.text) or AMOUNT_TOKEN.fullmatch(line.text)
    }
    if not values or len(values) == len(lines):
        return lines
    pairs: list[tuple[int, int]] = []
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
        if (
            len(label) + 1 + len(lines[second].text) <= max_quote_length
            and any(char.isalpha() for char in label)
            and not (DATE_TOKEN.search(label) or AMOUNT_TOKEN.search(label))
        ):
            pairs.append((first, second))

    if not pairs:
        return lines
    counts = Counter(index for pair in pairs for index in pair)
    replacements: dict[int, ExtractedLine] = {}
    consumed: set[int] = set()
    for first, second in pairs:
        if counts[first] != 1 or counts[second] != 1:
            continue
        a, b = lines[first], lines[second]
        x0, y0, _, y1 = a.evidence.bbox
        _, value_y0, value_x1, value_y1 = b.evidence.bbox
        text = f"{a.text} {b.text}"
        evidence = a.evidence.model_copy(update={
            "text": text,
            "bbox": (x0, min(y0, value_y0), value_x1, max(y1, value_y1)),
        })
        replacements[min(first, second)] = ExtractedLine(text=text, evidence=evidence)
        consumed.add(max(first, second))
    return [replacements.get(index, line) for index, line in enumerate(lines)
            if index not in consumed]
