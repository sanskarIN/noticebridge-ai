"""Create fully fictional PDF notices for safe, reproducible demos and testing."""

import argparse
from pathlib import Path

import pymupdf as fitz

# These are fictional examples; neither is issued by a real organization.
COMMON = [
    "Eligibility: Class 12 or equivalent",
    "Required documents: photograph and identity card",
    "Application portal: example.invalid",
    "Exam schedule: to be announced separately",
]
NOTICE_ORIGINAL = [
    "Application deadline: 13 December 2026",
    "Application fee: Rs. 500",
    *COMMON,
]
NOTICE_REVISION = [
    "Application deadline: 19 December 2026",
    "Application fee: Rs. 350",
    *COMMON,
]


def generate_pdf(path: Path, *, title: str, lines: list[str]) -> None:
    """Generate a deliberately non-authoritative single-page source document."""
    pdf = fitz.open()
    page = pdf.new_page(width=595, height=842)
    page.draw_rect(fitz.Rect(0, 0, 595, 118), color=None, fill=(0.05, 0.14, 0.23))
    page.insert_text((45, 46), "NOTICEBRIDGE AI  /  TEST DOCUMENT",
                     fontsize=11, color=(0.58, 0.89, 0.76))
    page.insert_text((45, 86), title, fontsize=24, color=(1, 1, 1))
    page.insert_text((45, 151), "FICTIONAL NOTICE - NOT VALID FOR APPLICATIONS",
                     fontsize=11, color=(0.73, 0.21, 0.21))
    for i, line in enumerate(lines):
        y = 225 + 46 * i
        page.draw_rect(fitz.Rect(44, y - 18, 551, y + 17),
                       color=(0.83, 0.87, 0.91), fill=(0.96, 0.98, 1))
        page.insert_text((57, y + 3), line, fontsize=11.3, color=(0.10, 0.19, 0.25))
    page.insert_text((45, 788),
                     "Generated synthetic content. Uploaded order does not prove authority.",
                     fontsize=9, color=(0.39, 0.43, 0.48))
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf.save(path, no_new_id=True)
    pdf.close()


def generate_pair(destination: Path) -> tuple[Path, Path]:
    original = destination / "original-fictional-notice.pdf"
    revised = destination / "revised-fictional-notice.pdf"
    generate_pdf(original, title="Fictional Notice", lines=NOTICE_ORIGINAL)
    generate_pdf(revised, title="Fictional Notice", lines=NOTICE_REVISION)
    return original, revised


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("demo-output"))
    args = parser.parse_args()
    for name in generate_pair(args.output):
        print(name)
