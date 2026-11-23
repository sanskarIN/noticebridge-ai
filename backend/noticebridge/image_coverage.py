"""Identify large page images with little selectable text over them."""

import math

import pymupdf as fitz

from .models import ExtractedLine

MIN_IMAGE_PAGE_FRACTION = 0.55
MIN_IMAGE_SIDE_PIXELS = 128
MIN_OVERLAY_CHARACTERS = 80


def has_unchecked_image(page: fitz.Page, lines: list[ExtractedLine]) -> bool:
    """Use image placement and text geometry without reading image pixel data."""
    # Image and text boxes use unrotated coordinates relative to the crop box.
    width, height = page.rect.width, page.rect.height
    if page.rotation in (90, 270):
        width, height = height, width
    bounds = fitz.Rect(0, 0, width, height)
    page_area = width * height
    if not math.isfinite(page_area) or page_area <= 0:
        return False

    try:
        images = page.get_image_info(hashes=False, xrefs=False)
    except (RuntimeError, ValueError):
        # Coverage hints must not invalidate otherwise usable native text.
        return False
    largest: fitz.Rect | None = None
    largest_area = page_area * MIN_IMAGE_PAGE_FRACTION
    for image in images:
        if min(image["width"], image["height"]) < MIN_IMAGE_SIDE_PIXELS:
            continue
        box = image["bbox"]
        if not all(math.isfinite(value) for value in box):
            continue
        visible = fitz.Rect(box) & bounds
        area = visible.get_area()
        if area >= largest_area:
            largest, largest_area = visible, area
    if largest is None:
        return False

    overlay_characters = 0
    for line in lines:
        x0, y0, x1, y1 = line.evidence.bbox
        if ((x0 + x1) / 2, (y0 + y1) / 2) in largest:
            overlay_characters += sum(character.isalnum() for character in line.text)
            if overlay_characters >= MIN_OVERLAY_CHARACTERS:
                return False
    return True
