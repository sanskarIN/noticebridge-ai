# Evaluating labeled notice pairs without overstating accuracy

NoticeBridge AI can score its **deterministic, evidence-linked matching** against
locally curated PDF pairs. The dataset owner supplies ground-truth page numbers
and exact source quotations. The benchmark does not decide whether an issuer,
notice, deadline, or eligibility criterion is officially valid.

This is **different** from the fictional examples under
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

## Start with a blank, pinned source register

For a new human-review corpus, collect permission-safe PDFs manually into a
private dataset folder. Keep the actual publication URLs, retrieval dates and
permission records in a separate private register; do not publish personal
information. Use a JSON source register with no expected quotations or hashes:

~~~json
{
  "version": 1,
  "cases": [
    {
      "id": "sample-01",
      "source_kind": "fictional",
      "issuer_group": "fictional-board",
      "event_group": "registration-2026",
      "original": "old.pdf",
      "revised": "new.pdf"
    }
  ]
}
~~~

~~~sh
PYTHONPATH=backend python backend/benchmarks/build_evaluation_sources.py \
  evaluation/source-register.json --output evaluation/source.json
~~~

The command validates the local paths and PDF signatures, fingerprints the
bytes, rejects repeated unordered PDF pairs, and writes a new version-2 manifest
with empty labels and explicit `unreviewed` status. It never downloads,
extracts or labels documents. The header check is not full PDF validation.
Identifiers group related notice versions; use consistent pseudonymous
issuer/event identifiers across all splits. These declarations are not verified
by the software. The blind review preparer preserves both grouping identifiers
and reconciliation rejects changes to them.

For a strict split audit, add `--require-event-groups` to
`audit_evaluation_split.py`. Shared declared issuer/event groups fail even
when the actual PDF bytes differ; missing groups also fail in strict mode.
Case-insensitive identifiers reduce accidental casing discrepancies. This
does not detect incorrect declarations or semantically equivalent notices.

## Version-2 pinned input sources for reproducibility

Version 1 remains supported for simple local experiments. For a corpus you
intend to use in release evaluation, **version 2 is preferable**: it requires
SHA-256 digests for the exact original/revised PDF bytes and records the
operator-declared provenance of the source and its labels. If a PDF file
changes later, scoring fails rather than silently using different inputs.

After reviewing and labeling your PDFs independently of NoticeBridge predictions,
convert a version-1 manifest without changing any expected page/quote pairs:

```sh
PYTHONPATH=backend python backend/benchmarks/pin_labeled_dataset.py demo-output/labels.json \
  --source-kind fictional --label-method author_reviewed
PYTHONPATH=backend python backend/benchmarks/evaluate_labeled.py \
  demo-output/labels-pinned.json --require-pinned-sources
```

The conversion creates a new file exclusively; it **will not overwrite**
existing labels. Source kinds: `fictional`, `public_notice`, or `consented`.
Label methods: `unreviewed`, `synthetic`, `author_reviewed`, or `independent_human`.
An `unreviewed` source inventory cannot be scored even if its completion
flag is changed. Create it with the source register command rather than the
legacy label pinning command, which requires a label method other than
`unreviewed`.
These are operator claims, **not** independent attestations by the software.
Do not choose `independent_human` for labels prepared using the system's own
predictions or generated by an AI model.

The pinned manifest has this shape; replace the example digests with values
calculated from your actual PDFs (the converter does that automatically):

```json
{
  "version": 2,
  "cases": [
    {
      "id": "fictional-demo",
      "original": "original-fictional-notice.pdf",
      "revised": "revised-fictional-notice.pdf",
      "original_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "revised_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "source_kind": "fictional",
      "label_method": "author_reviewed",
      "expected_pairs": []
    }
  ]
}
```

The empty `expected_pairs` array above is a **schema illustration**, not a
gold-standard annotation. Fill it with independently reviewed source excerpts.
The evaluator reports a canonical manifest SHA-256 (stable under JSON whitespace
and key order changes) and source-kind/label-method case counts. It rejects
duplicate JSON field names and labels that point outside their source PDF.
The pinned-source option rejects legacy manifests before opening either PDF. It still does
not prove that any source issuer or annotation is authentic. Blank scanned
pages can legitimately have human visual labels; the evaluator must not
require the same text extractor under test to confirm its own labels.

## 2. Run the evaluator

Install the backend, then run from repository root:

```sh
python -m pip install -e './backend[dev]'
PYTHONPATH=backend python backend/benchmarks/evaluate_labeled.py demo-output/labels.json
```

Optional CI gates use raw precision and recall counts and a limit on
unsupported confirmed pairings:

```sh
PYTHONPATH=backend python backend/benchmarks/evaluate_labeled.py demo-output/labels.json \
  --min-precision 0.90 --min-recall 0.90 --max-unsupported-confirmed 0
```

The command is entirely local, calls the isolated PDF comparison worker, and
**never** calls Ollama or a cloud model. OCR is **off by default**; for a scanned
evaluation corpus, explicitly opt into local Tesseract English/Hindi OCR:

```sh
PYTHONPATH=backend python backend/benchmarks/evaluate_labeled.py \
  demo-output/labels-pinned.json --require-pinned-sources --enable-ocr
```

For a pinned recovery experiment, add `original_ocr_pages` and/or
`revised_ocr_pages` as arrays of one-based page numbers inside a case, for
example `"revised_ocr_pages": [2, 4]`. Running the same manifest with
`--enable-ocr` applies those selections, while the default run measures
native extraction. The case output reports the applied page selection and
the pages that yielded OCR text. Both runs retain the same manifest and PDF
fingerprints.

Check that the backend host actually has Tesseract plus `eng` and `hin`
language data. Results report `ocr_enabled`, the number of
`ocr_page_count` pages, `pages_without_text_count`, per-case OCR page counts,
processing warnings, and incomplete-case counts. The separate
`unchecked_image_page_count` and per-document page numbers flag large images on
pages with some native text. If no OCR data is available,
the tool does not invent transcriptions or artificially increase recall.
Do not compare OCR-on and OCR-off evaluation results without identifying the
different extraction mode and environment. OCR-derived possible text
relationships must not be interpreted as confirmed official changes.
The experimental AI pairing feature still requires a separately designed
evaluation protocol before performance claims.

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
- **Unsupported confirmed changes:** predicted pairs labeled
  `confirmed_change` that are absent from the operator's labels.
- **Confirmed-only precision and recall:** the same formulas after restricting
  predictions to `confirmed_change`. Recall still uses every labeled pair as
  its denominator.

If a denominator is zero, the metric is **null**, not 100%. The output also
counts cases with incomplete PDF text coverage and cases with skipped fuzzy
candidate work. Missing-information statements,
intra-document contradictions, date/fee parser quality, OCR transcription
accuracy, semantic equivalence, and official authority are **not** scored by
these pair-level metrics.

A tiny synthetic demo yielding 100% precision and recall proves only that the
sample passed. It does not imply real-world accuracy.

## Preventing synthetic results from masking independent results

The evaluator reports **micro-averaged** precision, recall, and confirmed-only
counts for each manifest-declared source kind, labeling method, and combined
source/label cohort. The JSON cohorts object also includes
declared_independent_nonfictional, containing **only** cases declaring
public_notice or consented sources **and** independent_human labels.

This matters when a corpus includes many easy fictional regression pairs and
a smaller set of difficult real-notice cases. The combined headline score
can look good even if performance on the declared independent cases is poor.
Inspect stratified counts and uncovered pages in each cohort, not just the
aggregate score. Undefined ratios remain null; a cohort with zero cases does
**not** receive a 100% score.

For an explicit release-evaluation check, use an exclusively non-fictional,
independently human-labeled version-2 manifest:

~~~sh
PYTHONPATH=backend python backend/benchmarks/evaluate_labeled.py \
  evaluation/independent-pinned.json --require-pinned-sources \
  --require-independent-corpus --min-independent-cases 20 \
  --min-independent-distinct-pairs 20 --require-distinct-independent-pairs \
  --min-precision 0.90 --min-recall 0.90 --max-unsupported-confirmed 0
~~~

The output reports the SHA-256 fingerprints of the exact compared PDFs
for each case, and a unique source-pair count per cohort. Repeated case IDs
are already invalid, but repeating the same two PDF files under different
IDs could still inflate a sample count. The distinct-pairs gate prevents
that; reversed upload order counts as the same source pair for diversity.

The sample count and thresholds above are **operator-configured targets**,
not statistically validated guarantees. The gate exits nonzero if any case
lacks the declared eligible provenance, the minimum count is unmet, or
the requested score thresholds fail.

For a **mixed** manifest, use explicit independent-cohort accuracy gates.
An overall score can pass even while its smaller independent cohort fails:

~~~sh
PYTHONPATH=backend python backend/benchmarks/evaluate_labeled.py \
  evaluation/mixed-pinned.json --require-pinned-sources \
  --min-independent-cases 20 --min-independent-distinct-pairs 20 \
  --require-distinct-independent-pairs \
  --min-independent-precision 0.90 --min-independent-recall 0.90 \
  --max-independent-unsupported-confirmed 0 \
  --max-independent-incomplete-cases 0 \
  --max-independent-unchecked-image-cases 0 \
  --max-independent-limited-matching-cases 0
~~~

Evidence-pair accuracy is not enough when some pages have no usable text
or the matcher exhausts its candidate budget. Optional
`--max-independent-incomplete-cases N` limits cases with incomplete text
coverage after any opted-in OCR. Optional
`--max-independent-unchecked-image-cases N` separately limits cases with
image-heavy pages that may conceal unextracted text, even when every page
has selectable text. Optional `--max-independent-limited-matching-cases N`
limits cases whose fuzzy matching was explicitly reported as limited.
Set all three to `0` for a strict release gate; use larger thresholds only
with an explicit, recorded exception review. All three fail on an empty
declared independent cohort. The image heuristic can miss some image content. A
complete text-coverage result does **not** prove OCR accuracy, source
authenticity or completeness of a notice's meaning.

These flags evaluate **only** the declared independent non-fictional
cohort, using raw exact evidence-pair counts before rounding. Their
thresholds cannot be met by adding high-scoring fictional examples.
An empty independent cohort fails any requested independent accuracy gate,
including an unsupported-confirmed maximum of zero. Undefined precision
or recall also fails a corresponding minimum gate, even if that minimum
is zero. These independent flags can be combined with aggregate gates
to require good performance in both populations.

The older `--min-precision`, `--min-recall`, and
`--max-unsupported-confirmed` flags still evaluate **all cases**. The
minimum-independent-count and distinct-pair gates alone do not alter
those aggregate metrics or de-duplicate repetitions when computing
accuracy. A minimum of 20 distinct pairs can still be accompanied by
hundreds of repeated easy pairs, inflating micro-averaged scores.
Use `--require-distinct-independent-pairs` to reject any repetition of
the same two PDF SHA-256s in the independent cohort (including reversal).
This gate does not detect semantically duplicate PDFs with different bytes
or authenticate metadata; audit corpus construction separately.
Use the isolated accuracy gates when evaluating mixed data;
for a fully independent dataset, `--require-independent-corpus`
makes the overall and independent populations equivalent.

**Critical limitation:** NoticeBridge does not authenticate source-kind or
label-method metadata. Someone could label fictional or AI-generated examples
as independent_human. These flags prevent accidental mixing; they cannot
prove representative data, independent annotation, consent or issuer authority.
Keep signed-off dataset provenance and adjudication records outside the tool.

### Inspect false matches without collecting a new dataset

The optional --include-error-examples flag prints **up to five** normalized
source passage pairs per case for false positives, false negatives and
unsupported confirmed pairings. Each example shows both PDF page numbers,
a 180-character preview on each side, truncation flags, a stable SHA-256 of
the complete normalized page/quote key, and its occurrence count. The
underlying micro-averaged metrics always use **all** errors, not only sampled
examples. No source evidence is invented to fill empty cohorts.

~~~sh
PYTHONPATH=backend python backend/benchmarks/evaluate_labeled.py \
  evaluation/independent-pinned.json --require-pinned-sources \
  --include-error-examples
~~~

This flag is **off by default** because quotations may contain private or
permission-restricted information. Use it on a trusted local machine; do not
upload its JSON output to public CI logs or an issue tracker without redacting
the previews. Truncated normalized excerpts are for triage, not substitutes
for the full original PDF and human adjudication.

## Separate opt-in local AI experiment

The deterministic evaluator never calls the model. To measure incremental
utility of semantic proposals, use this separate SHA-pinned experiment with
Ollama running on a trusted local machine:

~~~sh
PYTHONPATH=backend python backend/benchmarks/evaluate_semantic.py \
  evaluation/independent-pinned.json --run-local-model \
  --min-independent-distinct-pairs 20 \
  --min-independent-proposal-precision 0.90 \
  --min-independent-miss-recovery 0.20
~~~

Opt-in sends bounded unmatched PDF excerpts to the fixed loopback endpoint.
Do not run on private data without authorization; ensure the local server
does not forward requests elsewhere. Both worker runs use the same bytes
and OCR selections. Changes to deterministic findings, checklist, coverage
metadata or warning prefix abort scoring. Proposals earn credit only for
labeled occurrences missed by the baseline; unsupported or redundant
proposals count against incremental precision. Recovery divides newly
recovered gold occurrences by all baseline-missed occurrences. Undefined
denominators remain null. JSON reports counts, source hashes, case IDs,
model outcomes, coverage and elapsed times, not source quotes.

The command exits nonzero if any model run is unavailable or no proposals
are admitted. Independent gates use raw counts, reject undefined metrics
and exclude fictional cases. The distinct-pair gate rejects repetitions
and requires an independent proposal. Targets above are engineering goals,
not measured performance. Record exact model weights and environment
separately; a configured model name is not a weight fingerprint.
This measures alignment, not semantic truth, issuer authority, or
correctness of recommended actions, and does not replace the deterministic
release gate.

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

### Audit development/held-out split isolation

Before adjusting engine thresholds or measuring a held-out corpus, compare
the two pinned manifests:

~~~sh
python backend/benchmarks/audit_evaluation_split.py \
  evaluation/dev/labels.json evaluation/heldout/labels.json
~~~

The audit rechecks every source hash and reports shared document bytes even
if filenames, roles or case IDs differ. Repeated unordered PDF pairs within
either split and any cross-split document overlap fail the check. A document
can occur in multiple distinct pairs within one split, such as a sequence
of amendments. The report contains fingerprints and case IDs, not source
quotes; no extraction or model inference runs.

Passing this audit proves byte-level separation and, when supplied,
separation of declared event groups. PDFs regenerated with different bytes
may still contain the same content. Keep related
notice versions, issuer/event families and near-duplicates together within
one split; manually review provenance and never tune against the final
held-out set.

### Reconcile two independent reviews

Generate separate blank reviewer copies from a version-2 pinned source manifest:

~~~sh
python backend/benchmarks/prepare_independent_review.py \
  evaluation/source.json --output evaluation/review-a.json
python backend/benchmarks/prepare_independent_review.py \
  evaluation/source.json --output evaluation/review-b.json
~~~

The preparation tool verifies all PDF fingerprints, copies only source identity
and OCR selection fields, strips existing quotations, predictions and audit
metadata, and writes empty `expected_pairs` arrays with `review_complete: false`.
It refuses to overwrite a review file. Distribute the copies independently;
do not distribute an existing answer key or engine predictions. Have each
reviewer label the PDFs without seeing the other person's labels. In each finished case, set
`"label_method": "independent_human"` and `"review_complete": true`. The
completion field distinguishes a reviewed case with zero expected pairs from an
unreviewed case. Both evaluators reject any explicitly incomplete case before
starting a worker. Older manifests without the field still work for
compatibility. Use pseudonymous reviewer IDs.

Before reconciliation, check both finished copies against the same source:

~~~sh
python backend/benchmarks/prepare_independent_review.py \
  evaluation/source.json --check evaluation/review-a.json
python backend/benchmarks/prepare_independent_review.py \
  evaluation/source.json --check evaluation/review-b.json
~~~

This reports only case counts and manifest fingerprints, checks source identity,
PDF hashes and declared completion, and never scores or extracts quotations.
It cannot prove that a person actually reviewed the PDFs independently.

Run the reconciliation from the repository root. Keep the manifests in the same
directory as each other so their relative PDF paths refer to the same dataset.

~~~bash
python backend/benchmarks/reconcile_labeled_reviews.py \
  evaluation/review-a.json evaluation/review-b.json \
  --reviewer-a reviewer-a --reviewer-b reviewer-b \
  --output evaluation/labels-reconciled.json
~~~

The audit prints case IDs, counts, and input manifest fingerprints. It omits
source quotations. Exact pair agreement uses the same page numbers, quote
normalization, and occurrence counts as the evaluator. The positive pair
agreement score is twice the number of shared pairs divided by the total number
of pairs labeled by both reviewers, with a null score when neither labels a pair.

If reviewers disagree, the command exits with status 1 and leaves the output
path untouched. Have a third person review only the disputed cases against the
PDFs. Their separate version-2 manifest must include every disputed case
and its complete corrected labels, even when the correct result is an empty list.
Mark those cases complete and rerun with
`--adjudication evaluation/review-c.json --adjudicator reviewer-c`. The resolved
manifest retains the audit and can be passed to `evaluate_labeled.py` with
`--require-pinned-sources`. Use the independent-corpus gate for the required
number of distinct non-fictional pairs.

Before scoring a previously reconciled manifest, verify it against the
original review files with the same reviewer IDs and adjudication options:

~~~bash
python backend/benchmarks/reconcile_labeled_reviews.py \
  evaluation/review-a.json evaluation/review-b.json \
  --reviewer-a reviewer-a --reviewer-b reviewer-b \
  --verify evaluation/labels-reconciled.json
~~~

This recomputes the reconciliation, checks the pinned PDF bytes again, and
compares the full canonical JSON fingerprint of the saved manifest against the
new result. It accepts changes in JSON whitespace or object key order, but
rejects changed labels, reviewer declarations, audit fields, extra claims, and
different input review fingerprints. Array order remains significant. For an
adjudicated corpus, supply the same third-review options. Verification never
rewrites the manifest; a mismatch or unresolved disagreement exits nonzero.
This is a local consistency check, not a digital signature or an authentication
of the reviewers. Keep the original review files in trusted storage.

Review completion and reviewer roles are recorded declarations. The command
checks that both reviews refer to the same pinned PDFs and uses the adjudicated
labels for disputed cases. The private review manifests preserve source
quotations and should stay with the evaluation data.

When reporting results, state sample counts, scope, version/commit, extraction
coverage, and known failure cases. Keep exact user or applicant data private.
A public GitHub demo should use fictional or properly permissioned documents.

**Non-negotiable:** an evidence match is not proof of issuer authority or a
legal deadline. Users must still inspect the issuing organization's official
source before making consequential decisions.

## Preflight positive label quotations

Use the optional native-quote audit after human review/reconciliation and before
scoring, with only trusted, permission-safe local PDFs. It runs native extraction
in the developer process, not the isolated API worker; do not expose it as an
upload service. No OCR, AI inference or comparison predictions are run.

~~~sh
PYTHONPATH=backend python backend/benchmarks/audit_review_quotes.py \
  evaluation/labels-reconciled.json
~~~

This verifies source hashes and checks normalized full extracted lines at each
labeled page. It reports counts and bounded case/pair/role/page flags without
including quotations. Repeated identical pairs require enough matching source
line occurrences; distinct pairs may reuse one endpoint. A selected OCR page,
missing-text page or image-heavy unchecked page requires visual review instead
of receiving native-exact status. Missing native lines may be caused by wrapping,
layout or extraction limits, not necessarily inaccurate human labels.

For a strictly native-text cohort, add `--require-native-exact` to fail on any
flag or a corpus with no positive endpoints. Do not use this strict gate to
exclude legitimate OCR or hard-layout cases from real-world evaluation. A
negative case has no positive quotation to check; this audit does not establish
label completeness, human independence, visual truth or official authority.
Never edit human labels merely to make the comparator's extraction agree.

## Browser-based independent review workbench

For manual label preparation, use the [offline workbench](../tools/review-workbench/README.md).
It uses blank pinned manifests, local fingerprint checks, manual page/quote
entry, resumable drafts and explicit completion before export. It is a local
review utility, not part of the public comparison API. Keep corpus documents
outside the served folder and verify exported labels with the backend tools.

### Earlier/revised date-table evidence

A bounded native ruled three-column grid with an explicit activity/requirement,
earlier-date and revised-date header can preserve the row's label and both
printed dates as one quotation and union bounding box. It never invents a
connector, silently removes the earlier date, or decides which column governs.
Rows are review-only; a change in their text is not a confirmed date delta.
The page warning asks users to inspect the actual headers. Reversed/unknown
headings, ambiguous dates, incomplete or multiline cells, unsupported layouts
and OCR retain their original passages. This narrow geometry rule is not a
general table parser or an authority check.
