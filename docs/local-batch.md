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
