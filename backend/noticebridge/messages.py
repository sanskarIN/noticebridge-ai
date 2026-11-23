"""Deterministic, bilingual findings and human-review messages.

These messages are verification policy, not extracted notice text. The worker
uses them to build the report; the parent independently checks exact wording
before displaying or exporting the result.
"""

HINDI_CATEGORY = {
    "deadline": "अंतिम तिथि",
    "eligibility": "पात्रता",
    "fee": "शुल्क",
    "time": "समय",
    "instruction": "निर्देश",
}

SUMMARY_MESSAGES = {
    "missing_original": (
        "Only the original text extraction yielded this passage. Check both source PDFs.",
        "यह अंश केवल मूल सूचना से निकाले गए पाठ में मिला। दोनों PDF के मूल पृष्ठ जाँचें।",
    ),
    "missing_revised": (
        "Only the updated text extraction yielded this passage. Check both source PDFs.",
        "यह अंश केवल संशोधित सूचना से निकाले गए पाठ में मिला। दोनों PDF के मूल पृष्ठ जाँचें।",
    ),
    "confirmed_change": (
        "Document wording differs at matched source passages. Authority is not verified.",
        "संबंधित स्रोत अंशों के शब्द अलग हैं; आधिकारिक प्राथमिकता सत्यापित नहीं है।",
    ),
    "possible_change": (
        "Possibly related passages differ; check the source context.",
        "संभवतः संबंधित अंश अलग हैं; स्रोत का संदर्भ जाँचें।",
    ),
    "explicit_amendment": (
        "The updated notice states a change from the quoted original value. Verify both sources.",
        "संशोधित सूचना में मूल मान से बदलाव लिखा है। दोनों स्रोत जाँचें।",
    ),
    "contradiction": (
        "Conflicting calendar dates appear under one label on the same PDF page.",
        "PDF के एक पृष्ठ पर समान शीर्षक के अंतर्गत अलग तिथियाँ मिली हैं।",
    ),
    "semantic_proposal": (
        "Local AI proposes that these passages may be related. "
        "Neither the pairing nor the official authority is verified.",
        "स्थानीय AI ने इन अंशों का संभावित संबंध सुझाया है। "
        "यह मिलान और आधिकारिकता सत्यापित नहीं हैं।",
    ),
}


def review_messages(category: str, *, semantic: bool = False) -> tuple[str, str]:
    """Return only known safety-preserving checklist text for a category."""
    if category not in HINDI_CATEGORY:
        raise ValueError("Unsupported review category")
    if semantic:
        return (
            f"Verify the AI-suggested {category} match against both official source passages.",
            f"AI के सुझाए गए {HINDI_CATEGORY[category]} मिलान के दोनों मूल अंश जाँचें।",
        )
    return (
        f"Verify the {category} statement with the official issuer.",
        f"जारीकर्ता के आधिकारिक स्रोत से {HINDI_CATEGORY[category]} संबंधी कथन की पुष्टि करें।",
    )
