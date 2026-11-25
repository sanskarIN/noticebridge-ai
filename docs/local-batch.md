# Local batch comparison and replay

For reviewing a small collection of notice pairs, the offline batch command
creates a private evidence report for each pair and a quote-free index. It
uses the same isolated worker as the single-comparison CLI. It is intended
for a trusted local environment, not public uploads or bulk corpus scraping.

## Prepare a pinned manifest

Place a JSON file beside the PDF folders. Paths are relative to the manifest
folder, use forward slashes, and must resolve to regular PDFs inside it.
Use SHA-256 fingerprints of the actual file bytes:

- Linux: sha256sum original.pdf revised.pdf
- PowerShell: Get-FileHash -Algorithm SHA256 original.pdf, revised.pdf

Use lowercase hexadecimal digests in the manifest. Replace the illustrative
zero/one values below with actual hashes.

```json
{
  "version": 1,
  "cases": [
    {
      "original": "notices/original.pdf",
      "revised": "notices/revised.pdf",
      "original_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "revised_sha256": "1111111111111111111111111111111111111111111111111111111111111111"
    }
  ]
}
```

The manifest accepts 1–16 pairs, a maximum of 64 KiB, exactly the fields
shown, and no repeated pinned pair. Files are limited to 10 MiB each.
Native-text mode only: automatic OCR, selected OCR and AI suggestions are
not enabled in this batch workflow. The single-document CLI remains
available for explicit OCR recovery.

## Run and verify

```bash
python -m noticebridge.batch_cli run manifest.json --output batch-review
python -m noticebridge.batch_cli verify manifest.json --output batch-review
```

The output directory must not already exist. It contains case-001.json,
case-002.json, etc., plus index.json. Each evidence file is published using
the same no-overwrite atomic helper as the single-comparison CLI. Reports
contain source quotations and must remain private. The index contains only
generated report names, counts, hashes, coverage and fixed policy text.
The terminal emits only aggregate counters and the manifest fingerprint.

The batch stops at the first failed comparison, preserving the completed
prefix and publishing an explicitly incomplete index. The command exits
nonzero and verification refuses incomplete indexes. Use a new directory
for a retry. If interrupted before index publication, the directory is not
a complete batch and cannot pass verification. No in-place resume or
overwrite is provided. Use the recovery command below to create a new batch. The total serialized evidence budget is 128 MiB,
with a maximum of 64 MiB per report.

Verification rereads the manifest and sources, validates exact source
fingerprints, parses the saved report strictly, runs a new isolated
comparison, and reconstructs the index. Changing the saved index alone
cannot establish verification. A matching replay establishes consistency
with the local engine and inputs, not notice authenticity. Record the
manifest hash separately if you need to detect later manifest replacement.
Both commands must use a compatible engine version.

## Limitations

- Source pins establish byte identity, not issuer authenticity.
- The input and output directories must be locally trusted; path checks
  are not an operating-system sandbox against concurrent filesystem changes.
- Windows output privacy depends on inherited directory ACLs, and POSIX
  mode bits do not guarantee secure erasure.
- Missing or image-only text remains incomplete or inconclusive. A batch
  can be structurally complete without complete source-text coverage.
- Batch counters are not independent accuracy measurements. They must not
  be represented as precision, recall, or evidence of legal authority.
- Use the separately labeled evaluation workflow for release quality claims.


## Prepare pins automatically

Instead of manually computing hashes, create a plan JSON beside the source
folders containing the version and explicit original/revised paths, without
the SHA-256 fields. The order is supplied by the user; filename dates do not
prove chronological or official precedence.

```json
{
  "version": 1,
  "cases": [
    {"original": "notices/original.pdf", "revised": "notices/revised.pdf"}
  ]
}
```

```bash
python -m noticebridge.batch_cli prepare plan.json --output manifest.json
python -m noticebridge.batch_cli check manifest.json
```

Preparation fingerprints each bounded PDF and atomically creates a new
manifest; it never overwrites a previous pin. Keep the plan and output
manifest in the same folder. A source check verifies the current bytes
against every manifest fingerprint without parsing any PDF content.

## Audit before replay

```bash
python -m noticebridge.batch_cli audit manifest.json --output batch-review
```

The structural audit checks source pins, generated report bytes, index
counts and report digests, and internal evidence provenance. It does not
independently extract quotations from the original documents; a forged but
structurally consistent report may pass. Its output explicitly states
engine_replayed=false. Full verification first performs the structural
checks, then independently replays each case using a fresh worker and
rechecks all report and index bytes. Only a successful verify command
reports engine_replayed=true. Neither command authenticates the issuer.

## Browser batch review

Open the frontend and select **Inspect saved batch** in the navigation. The
browser accepts the generated index, optionally checks the pinned manifest's
SHA-256 and listed source fingerprints, and previews a selected case report
whose bytes match the index digest. No files are uploaded by this view. The
viewer accepts 128 KiB indexes, 64 KiB manifests and individual reports up to
8 MiB; use the CLI for larger reports. It displays at most 100 saved findings.

This view checks selected bytes and basic consistency, not the complete engine
schema, the original PDF bytes, or independently extracted quotations. A
self-consistent modified index and report can still mislead. The browser rejects duplicate JSON members, invalid UTF-8, non-finite numbers
and excessive JSON nesting before checking the supported fields. For authoritative
local consistency checks, run the structural audit and independent replay commands.
Use HTTPS or localhost for browser SHA-256 support.


## Recover an indexed partial batch

```bash
python -m noticebridge.batch_cli audit-prefix manifest.json --output batch-review
python -m noticebridge.batch_cli recover manifest.json --previous batch-review --output recovered
python -m noticebridge.batch_cli verify manifest.json --output recovered
```

The prefix audit checks only the recorded completed cases; it returns a
nonzero exit status if the batch is incomplete even when those checks
pass. Recovery requires a valid incomplete index and the original pinned
manifest. It checks every source, independently replays the completed
prefix before copying each verified report into a new directory, and
compares the remaining pairs. It never edits the previous directory.
If replay or a remaining comparison fails, the new index records only
its own successfully completed prefix. An interrupted directory without
a valid index cannot be recovered through this command. Verify the new
complete batch separately to replay every case.


## Inspect the actual source PDFs

For an opened case, attach the original and updated PDF separately in the
source inspection panel. Each file is limited to 10 MiB; its bytes must
match the role-specific saved SHA-256 before the viewer will render it.
The application creates an immutable snapshot of the checked bytes for the
local PDF.js viewer, rather than rereading unchecked filesystem bytes.

Use a finding's source-page button to display its recorded page. Valid
saved geometry is passed to the existing rotation-aware renderer, which
may reject a mismatched rectangle. Missing geometry displays an
unhighlighted page, not a guessed rectangle. Changing cases, clearing
files or loading a mismatched replacement invalidates the relevant preview.
No file is uploaded. This is manual source inspection; a matching saved
hash does not authenticate a notice, independently establish the accuracy
of a quotation, or replace full engine replay.


## Track human review progress

The browser case table includes a human review marker for each completed
case: not marked, review in progress, needs follow-up, or marked reviewed
by the user. Markers are organizational state and never modify saved
findings, establish issuer authority, or prove the user inspected the PDFs.
Use the human review filter to locate follow-up cases.

Export the review ledger JSON to resume your work later. It binds review
markers to the exact batch index SHA-256, manifest SHA-256, and report
fingerprints. Restoring a ledger validates those bindings and requires an
explicit confirmation before replacing current markers. The optional CSV
contains only case numbers, fixed categories, review markers, counts and
hashes, never source quotations or PDF filenames. A new index or page
reload clears the in-memory state. No marker is stored on a server.


## Reconcile two human review ledgers locally

Two reviewers can export their own ledgers from the browser using the same
exact saved batch index. The local review command validates the index,
source pins, completed evidence structure and both ledgers before comparing
markers. It does not replay the engine or validate an issuer.

```bash
python -m noticebridge.batch_review inspect manifest.json --batch batch-review --first reviewer-a.json
python -m noticebridge.batch_review compare manifest.json --batch batch-review --first reviewer-a.json --second reviewer-b.json --template resolution.json
```

A missing marker is not a disagreement. Matching marked states are kept;
a single explicit marker is retained. Conflicting explicit states require a
human decision. The optional resolution template pins both exact ledger
digests and the index digest, and initializes conflicts with null states.
Edit each null to one of in_progress, follow_up, reviewed or unreviewed,
the last of which removes the marker. Do not change any digest or case
number. A resolution cannot contain non-conflicting or repeated cases.

```bash
python -m noticebridge.batch_review merge manifest.json --batch batch-review --first reviewer-a.json --second reviewer-b.json --resolution resolution.json --output combined-review.json
```

Omit the resolution option if there are no conflicts. The combined ledger
can be restored in the browser. No input is overwritten. This is workflow
coordination, not independent annotation of notice accuracy; markers are
not proof of user identity, review quality, verified evidence, or authority.


## Try the complete workflow with fictional documents

The reproducible demonstration generator creates a new directory containing
three explicitly fictional notice pairs, a plan, a pinned manifest and an
actual batch report. It exercises deadline and fee changes, a blank page
with incomplete text coverage, and same-page conflicting deadline statements.

```bash
python backend/benchmarks/generate_batch_fixture.py --output fictional-batch --verify
```

Open fictional-batch/batch/index.json in the browser's local batch workspace,
then select fictional-batch/manifest.json. Choose each case report and its
matching original and updated PDF files from the generated directory.
Use review markers and export the ledger to try the reconciliation commands
above. The generator refuses to overwrite an existing destination. All
example documents are invented; the fixture must not be described as an
independent accuracy evaluation. The optional verify switch runs a separate
engine replay after generating the reports.

The automated browser interoperability tests generate the same fixture using
the production CLI, load the resulting report bytes rather than mocked
findings, export human markers, reconcile two ledgers through Python, and
restore the merged ledger in the browser. This tests contract compatibility
without requiring external services or real applicant information.
