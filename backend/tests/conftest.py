from collections.abc import Callable

import pymupdf as fitz
import pytest


@pytest.fixture
def pdf_bytes() -> Callable[[list[list[str]]], bytes]:
    def build(pages: list[list[str]]) -> bytes:
        doc = fitz.open()
        for lines in pages:
            page = doc.new_page()
            for i, line in enumerate(lines):
                page.insert_text((60, 80 + i * 24), line, fontsize=12)
        data = doc.tobytes()
        doc.close()
        return data

    return build
