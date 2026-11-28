"""Shared display-name normalization, independent of HTTP and CLI layers."""

import unicodedata


def safe_filename(filename: str | None, *, fallback: str) -> str:
    """Drop paths, controls and bidi-spoofing characters from display names.

    The resulting name is display metadata, never an authority assertion.
    """
    # Normalize before splitting path components: fullwidth solidus and
    # reverse-solidus characters become real separators under NFKC.
    normalized = unicodedata.normalize("NFKC", filename or fallback)
    basename = normalized.replace("\\", "/").split("/")[-1]
    # Preserve legitimate Indic combining marks and ZWJ while removing
    # explicit bidirectional display controls that can spoof extensions.
    bidi_controls = {"\u200e", "\u200f", "\u202a", "\u202b", "\u202c",
                     "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"}
    cleaned = "".join(c for c in basename if unicodedata.category(c) != "Cc"
                      and c not in bidi_controls).strip(" .")
    # Do not truncate the visible PDF suffix off a long accepted filename.
    # This name is display-only metadata, not a trusted filesystem path.
    if len(cleaned) > 200:
        if cleaned.casefold().endswith(".pdf"):
            cleaned = cleaned[:196].rstrip(" .") + ".pdf"
        else:
            cleaned = cleaned[:200].rstrip(" .")
    return cleaned or fallback
