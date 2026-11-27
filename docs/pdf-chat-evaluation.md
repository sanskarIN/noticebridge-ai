# Offline retrieval evaluation and private workspace

The chat system is an evidence retrieval tool, not an independently verified answer engine.
These workflows are optional and use locally attached PDF files.

## Create an independently reviewed retrieval dataset

1. Attach the original and/or revised PDF in PDF chat.
2. Open **Research: export private native index** and explicitly approve the export.
   The exported snapshot contains native extracted text, physical page coverage, source SHA-256
   fingerprints and geometry hints. Treat it as sensitive document data.
3. Rename each snapshot to a unique lowercase JSON filename, for example `notice-a.json`.
4. Review the actual PDF independently and label questions with the exact source fragment IDs.
   Do not derive reference labels from the system's answers. Use the same source roles as the snapshot.
5. Put all revisions of the same underlying notice into the same family and the same split.
   Keep the holdout split separate from tuning and query development.
6. Calculate the SHA-256 of each complete snapshot file. Use that digest in the label manifest.

For example, a **fictional** development manifest may contain:

```json
{
  "format": "noticebridge-retrieval-labels",
  "version": 1,
  "id": "fictional-example",
  "kind": "synthetic",
  "documents": [
    {
      "id": "notice-a",
      "family": "fictional-family-a",
      "split": "development",
      "snapshot": "notice-a.json",
      "snapshot_sha256": "REPLACE_WITH_THE_ACTUAL_64_CHARACTER_LOWERCASE_SHA256",
      "cases": [
        {
          "id": "a-fee",
          "slices": ["fee", "printed-field"],
          "question": "What is the application fee?",
          "scope": "original",
          "label": {
            "kind": "answerable",
            "evidenceSets": [["original:1:1"]]
          }
        },
        {
          "id": "a-refund",
          "slices": ["negative"],
          "question": "What is the refund policy?",
          "scope": "original",
          "label": { "kind": "unanswerable" }
        }
      ]
    }
  ]
}
```

The digest placeholder and evidence identities must be replaced with actual values. This is
not an evaluated dataset or a measurement of production accuracy. The manifest must specify
exactly one question per case. A question with explicit physical-page routing also requires
a matching integer `page` field.

The four label categories are:

- `answerable`: at least one complete acceptable evidence set exists in the indexed snapshot.
  Each set contains every fragment needed to substantiate the answer, not just one keyword hit.
- `unanswerable`: an independent reviewer found no answer in the inspected scope.
- `unindexed`: the relevant source material is not represented in the native index.
- `ambiguous`: wording or conditions prevent a single clear labeled interpretation.

Keep ambiguous or unindexed cases separate; do not count them as ordinary negatives.
The `independently_reviewed` manifest kind is an operator declaration, not something the
program can authenticate. Do not use it for synthetic, automatically generated or
system-derived labels.

## Run the local evaluation

From the frontend directory, after installing the locked npm dependencies:

```bash
npm run evaluate:retrieval -- --manifest /path/to/labels.json --split development --output /path/to/report.json
```

Use `--split holdout` for a separately prepared holdout split. Input files must be regular
local files; snapshots are restricted to simple filenames next to the manifest. The runner
checks each snapshot's SHA-256, rejects cross-family duplicate PDF fingerprints, validates
all fragment identities and rejects families spanning splits. It refuses to overwrite
an existing output file. No model, network call or hosted service is required.

The report records strict, contextual and all-strict retrieval results, labeled-case
counts, complete evidence-set recovery, citation precision/recall, abstention, routing
mismatches and role/page leakage. It records per-case transitions from strict retrieval
to the other modes. Each notice family retains its own term statistics. Reported metrics
are descriptive of the supplied dataset and are not a claim of real-world legal accuracy.

Reports do not include questions or extracted source quotes, but document IDs, family IDs,
slice labels and case IDs are included; choose non-sensitive identifiers.

## Candidate section outline

The outline uses explicit printed reference markers, a narrow numbered-heading grammar
and recognized standalone labels. It partitions native extraction order and does not
assert that the partitions are real logical sections. Open a candidate to inspect its
fragments, or explicitly choose a matching marker from the other PDF. Literal sequence
alignment shows identical paired wording and unpaired fragments. Duplicate markers,
repeated wording, missing pages and bounded alignment limits are disclosed.

## Complete workspace exchange

The complete private workspace combines the question plan and native review notebook.
The canonical file contains question text, search settings, personal annotations,
source fingerprints and saved fragment hashes. It does not automatically include PDF
bytes, extracted source quotes, model outputs or OCR transcriptions. Import requires
exactly matching PDF bytes and verifies each saved fragment's text against the local
index. Answers are recomputed; both components are staged before confirmation.
Replacing an attached PDF clears the current workspace. Neither export nor restore
uploads the artifact.

## Release verification

Synthetic unit and browser fixtures are regression checks, not an independent quality
benchmark. Before claiming a real-notice retrieval performance number, run a frozen,
independently reviewed holdout and publish its selection, labeling and coverage limitations.

## Manual labeling workbench

The research labeling panel provides a separate literal, source-ordered browser
of the indexed PDF. Create single-question cases and assign a source scope,
slice labels, and one of the four annotation categories. For answerable cases,
choose every fragment required for one complete answer; add alternative sets
only when each alternative is independently sufficient. The workbench never
copies retrieval results into the reference labels.

A private draft can contain incomplete cases and is pinned to the entire
native corpus snapshot, including extraction coverage and geometry. Restore
requires identical snapshot bytes and explicit replacement confirmation.
Final export requires structurally complete labels, explicit consent and a
human provenance declaration. Save the paired snapshot and labels file
together; the latter contains the exact snapshot digest. The existing offline
runner accepts the resulting manifest. The program cannot certify the
independence or accuracy of human annotations. Keep real holdout labels
separate from developers who tune retrieval.

## Compose separate annotation sessions

Give every individual manifest and snapshot a distinct simple lowercase filename
in one trusted local directory. Use stable globally unique case and document IDs.
Then compose without copying or modifying the snapshots:

```bash
npm run compose:retrieval -- --directory /path/to/study --id combined-study --output combined.json --inputs labels-a.json labels-b.json
```

Composition refuses conflicting document or case identities, duplicate snapshots,
mixed label provenance, split leakage and shared PDF fingerprints assigned to
different families. All source hashes and evidence IDs are checked before
publishing the combined manifest. Existing files are never overwritten.
The output lists documents in deterministic ID order, retaining all original
questions, labels and splits. The console audit reports counts and anonymous
identifiers only. Use the normal evaluation command with the combined manifest.

## Compare two evaluation runs

Retain evaluation reports from two revisions using the exact same manifest
bytes, snapshot hashes and split. Then run:

```bash
npm run compare:retrieval -- --before before.json --after after.json --output comparison.json
```

The comparison command independently recalculates totals, slice summaries,
family summaries, transition counts and integrity violations from each
report's case records. It rejects inconsistent records, differing
manifest fingerprints, split changes, changed case identities or
mismatched label provenance. It reports paired gains, losses, unchanged
successes and unchanged failures for complete evidence-set recovery and
negative abstention, separately from changes in aggregate rates. Undefined
denominators remain null. These are descriptive paired results, not
statistical significance or proof of factual correctness. The output
pins both report byte hashes and never overwrites an existing file.

## Private evidence review packets

The optional review packet is different from the quote-free notebook:
it explicitly includes the selected native excerpts and personal notes,
their text hashes, PDF fingerprints and extraction coverage. Export
requires separate consent. The printable HTML is a static reading copy
with escaped text and a restrictive content security policy. The
canonical JSON can be checked against the attached PDFs without
restoring or altering the editable review workspace.

For independent offline consistency checking, export the exact native
corpus snapshot as well and run:

```bash
npm run verify:packet -- --packet packet.json --snapshot snapshot.json --html reading-copy.html
```

The verifier reconstructs every identity, quote, hash, coverage status
and annotation count from the local extraction. A matching packet does
not authenticate the source document or certify personal notes. Keep
both the excerpt packet and the complete corpus private. The verifier
never overwrites an existing reading copy or prints source text.

## Independent reviewer agreement

Freeze the question set, case identities, document families, source scopes,
physical-page restrictions, slice membership and source snapshot hashes before
sending them to independent reviewers. Keep each reviewer's original manifest
and snapshot files in separate private directories. Do not let the reviewers
copy the current retrieval answer or see one another's labels before annotation.

```bash
npm run agree:retrieval -- --left reviewer-a/labels.json --right reviewer-b/labels.json --output agreement.json
```

The command checks both manifests against their pinned snapshots and pairs
cases only when every question and source-routing detail matches exactly.
It reports missing cases separately, never as negatives. The four-way
category confusion matrix, raw agreement and Cohen's kappa describe
category agreement; kappa is null when its denominator is undefined.
For cases labeled answerable by both reviewers, exact alternative-set
agreement, union Jaccard overlap and directional best-alternative coverage
describe different aspects of evidence agreement. Identical unions can
still disagree on which combinations of fragments constitute a sufficient
answer. Disagreements need adjudication against the actual PDF; the tool
does not choose a winner, create ground truth or certify reviewers.
Reports include anonymous IDs and evidence identities, not question text
or quotations, and pin both manifest hashes. Holdout labels should not
be exposed to retrieval developers before final evaluation.

The adjudication queue preserves complete original alternative sets on both
sides, including common alternatives and unmatched alternatives. A missing
reviewer label is represented as null, not as an unanswerable judgment.
Use the stable case and source identities to review the exact PDF pages.
An adjudicator should record a separate, independently reasoned final
label after inspecting the original documents; the tool does not merge
reviewer labels, resolve conflicts, or alter either input manifest.

## Reconcile independent annotations

Use the agreement report to find disagreements, but first require the first
two reviewers to finish exactly the same frozen set of cases. Missing labels
are not negative examples. Have a third reviewer inspect the original PDF
and record an independent final label for every disputed case in a separate
manifest. Their manifest must contain only the disputed cases. A final label
may choose a different category or a new complete evidence alternative; no
automatic union or majority vote is applied. Keep provenance declarations,
case IDs, families, question wording, scopes, page restrictions, slice
membership and exact snapshot fingerprints unchanged.

Run from the frontend directory:

```bash
npm run reconcile:retrieval -- --left reviewer-a/labels.json --right reviewer-b/labels.json --third reviewer-c/labels.json --id final-study --output reviewer-a/reconciled.json
```

When the two complete reviews agree on every category and complete alternative
set, omit the third input. The tool rejects incomplete pairing, mixed
provenance, unrequested adjudication cases, missing decisions, changed source
or question metadata, and evidence outside the frozen scope. All three input
manifests and their snapshot bytes are checked; reviewer IDs and the output
dataset ID must be distinct. A distinct declared ID is **not** proof of
identity or independence. The final dataset retains the declared provenance
of the inputs; synthetic fixtures remain synthetic.

The output is an ordinary retrieval-label manifest that refers to the first
reviewer's existing snapshot filenames. Therefore the output must be written
in the same private directory. Its canonical order is document ID, case ID,
slice ID and evidence alternative identity. The CLI prints aggregate counts,
split counts and input/output fingerprints without questions, quotes, local
paths or individual label details. Existing files are not overwritten.

To replay and check the exact output bytes, use the same arguments plus
`--verify`. Verification does not modify the output or regenerate missing
files. It fails when a source, decision, output ID or manifest byte differs
from the reconstructed result. Keep the original review files and exact PDF
bytes under restricted access; a reconciled label set still requires human
quality review and cannot establish official authority or factual correctness.

The pure reconciliation API additionally provides a per-case audit with
anonymous case IDs, resolution reason, chosen category and alternative count.
It contains no question text, native quotation, reviewer note, or source
fragment IDs. This audit is not a signed record of the human decisions.

### Strict research input handling

All offline retrieval-label manifests and evaluation reports reject repeated
JSON object members (including escape-equivalent spellings), nonfinite
numbers, malformed JSON and excessive nesting before schema validation.
Snapshot loading and dataset composition independently recompute SHA-256
from actual input text bytes instead of trusting a supplied hash string.
These checks do not authenticate the issuer or reviewer. Inputs must still
be kept in private, trusted directories.

## Frozen retrieval qualification plan

A metric report alone does not qualify a release. Before evaluating a held-out
corpus, the operator must record thresholds and minimum sample sizes, and
choose which retrieval modes and slices to qualify. Create a private
`policy.json` with the following shape (illustrative thresholds, **not**
an empirically established NoticeBridge release standard):

```json
{
  "id": "holdout-qualification",
  "purpose": "release",
  "split": "holdout",
  "minimums": {
    "cases": 100,
    "families": 10,
    "answerable": 60,
    "unanswerable": 30,
    "inaccessible": 5,
    "ambiguous": 5
  },
  "modes": [
    {
      "mode": "strict",
      "thresholds": {
        "citationPrecision": 0.9,
        "citationRecall": 0.85,
        "completeEvidenceRate": 0.8,
        "unanswerableAbstentionRate": 0.95
      },
      "slices": [
        {
          "slice": "deadline",
          "minimums": {
            "cases": 10,
            "families": 3,
            "answerable": 10,
            "unanswerable": 0,
            "inaccessible": 0,
            "ambiguous": 0
          },
          "thresholds": { "completeEvidenceRate": 0.9 }
        }
      ]
    }
  ]
}
```

Freeze the exact manifest and policy without computing retrieval metrics:

```bash
npm run qualify:retrieval -- freeze --manifest reconciled.json --policy policy.json --output plan.json
```

Run and verify against the exact same pinned native extraction:

```bash
npm run qualify:retrieval -- run --manifest reconciled.json --plan plan.json --output gate.json
npm run qualify:retrieval -- verify --manifest reconciled.json --plan plan.json --output gate.json
```

The gate checks global and slice support counts, each configured metric,
and zero routing/source integrity violations across all retrieval modes.
Undefined denominators fail any configured threshold; a missing slice
cannot pass merely by assigning a zero threshold. Release policies require
the holdout split, declared independently reviewed labels, at least two
source families, both answerable and unanswerable examples, and positive
thresholds for precision, recall, complete evidence recovery and
unanswerable abstention. Operators should set substantially stronger
cohort minima for a meaningful study. Synthetic studies may be used for
development policies only.

The run reconstructs the evaluation from the source snapshots, audits its
structure, and pins the evaluation, manifest and plan byte hashes in the
gate report. Exit code 0 means the frozen metric checks passed (or the
freeze operation succeeded); 2 means a valid run did not qualify; 1 means
invalid input, inconsistent replay or an unavailable destination. No file is
overwritten. Logs contain only aggregate status and fingerprints.

The result always sets `release_approved` to false. It does not establish
official notice authority, human reviewer independence, correct answer
meaning, model inference quality, or that a policy was registered before
holdout access. Record the plan digest separately before running the study,
keep holdout labels away from retrieval developers, and perform the wider
security, usability and release review independently.
