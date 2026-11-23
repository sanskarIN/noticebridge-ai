# Evaluating labeled notice pairs without overstating accuracy

NoticeBridge AI can score its **deterministic, evidence-linked matching** against
locally curated PDF pairs. The dataset owner supplies ground-truth page numbers
and exact source quotations. The benchmark does not decide whether an issuer,
notice, deadline, or eligibility criterion is officially valid.

This is **different** from the 12 fictional examples under
`backend/benchmarks/cases.json`: those are code regression fixtures, not a
representative real-world accuracy study.

## 1. Prepare two PDFs and a separate human-labeled manifest

Keep source PDFs and the manifest in the same local folder. Do not include
private applications or personal records in a public Git repository.

For a harmless starting point, first generate the fictional demo pair:

```sh
PYTHONPATH=backend python backend/benchmarks/generate_demo.py --output demo-output
```

Create `demo-output/labels.json` with this manifest. The snippets and page
numbers below are from the **fictional generated PDFs**, not real notices.

```json
{
  "version": 1,
  "cases": [
    {
      "id": "fictional-demo",
      "original": "original-fictional-notice.pdf",
      "revised": "revised-fictional-notice.pdf",
      "expected_pairs": [
        {
          "original_page": 1,
          "original_text": "Application deadline: 13 December 2026",
          "revised_page": 1,
          "revised_text": "Application deadline: 19 December 2026"
        },
        {
          "original_page": 1,
          "original_text": "Application fee: Rs. 500",
          "revised_page": 1,
          "revised_text": "Application fee: Rs. 350"
        }
      ]
    }
  ]
}
```

The evaluator deliberately forbids absolute/parent-traversal PDF paths and
symlinks outside the manifest folder. Give it a small, permission-safe local
corpus. Do not treat model-generated labels as independent ground truth.

## 2. Run the evaluator

Install the backend, then run from repository root:

```sh
python -m pip install -e './backend[dev]'
PYTHONPATH=backend python backend/benchmarks/evaluate_labeled.py demo-output/labels.json
```

Optional CI gate on explicitly chosen precision and recall thresholds:

```sh
PYTHONPATH=backend python backend/benchmarks/evaluate_labeled.py demo-output/labels.json \
  --min-precision 0.90 --min-recall 0.90
```

The command is entirely local, calls the isolated PDF comparison worker, and
**never** calls Ollama or a cloud model. OCR is disabled in this initial
evidence-pair metric runner. The experimental AI pairing feature therefore
requires a separate evaluation protocol before performance claims.

## 3. Interpret the numbers

A predicted pair is counted only when **both** PDFs have the expected
page number and normalized full source quotation. The normalized comparison
is case-insensitive and normalizes Unicode/whitespace. Multiple identical
labeled occurrences are counted with multiplicity.

- **True positive (TP):** a predicted source passage pair matches a labeled pair.
- **False positive (FP):** a predicted pair is absent from the labels.
- **False negative (FN):** a labeled pair was not predicted.
- **Precision:** TP / (TP + FP).
- **Recall:** TP / (TP + FN).
- **Unsupported confirmed changes:** unmatched predictions labeled
  `confirmed_change`, which deserve high-priority manual review.

If a denominator is zero, the metric is **null**, not 100%. The output also
counts cases with incomplete PDF text coverage. Missing-information statements,
intra-document contradictions, date/fee parser quality, OCR transcription
accuracy, semantic equivalence, and official authority are **not** scored by
these pair-level metrics.

A tiny synthetic demo yielding 100% precision and recall proves only that the
sample passed. It does not imply real-world accuracy.

## 4. Build a useful independent evaluation corpus

For the December completion gate, use a permission-safe, diverse set of
human-reviewed examples with recorded provenance:

- English, Hindi, bilingual and mixed-script notices.
- Scanned and native-text PDFs, tables, repeated headings, page order changes,
  poorly extracted pages, ambiguous numeric dates, fee revisions and amendments.
- Both genuine changes and unchanged-equivalent wording, including tricky
  negatives that expose false confidence.
- Labels reviewed without consulting NoticeBridge AI's predicted pairs; record
  disagreements and update adjudication separately from the benchmark outputs.
- A frozen test split independent of development examples and the fictional
  demonstration.

When reporting results, state sample counts, scope, version/commit, extraction
coverage, and known failure cases. Keep exact user or applicant data private.
A public GitHub demo should use fictional or properly permissioned documents.

**Non-negotiable:** an evidence match is not proof of issuer authority or a
legal deadline. Users must still inspect the issuing organization's official
source before making consequential decisions.
