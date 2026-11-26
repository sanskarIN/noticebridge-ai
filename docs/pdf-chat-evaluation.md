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
