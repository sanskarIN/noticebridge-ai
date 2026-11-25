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
a complete batch and cannot pass verification. No implicit resume or
overwrite is provided. The total serialized evidence budget is 128 MiB,
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
self-consistent modified index and report can still mislead. The browser's JSON
parser is not the strict duplicate-member parser used by the CLI. For authoritative
local consistency checks, run the structural audit and independent replay commands.
Use HTTPS or localhost for browser SHA-256 support.
