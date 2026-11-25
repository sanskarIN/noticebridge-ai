# Offline PDF comparison command

NoticeBridge AI also supports a **local, scriptable two-PDF comparison**.
It uses the same disposable comparison worker and parent-side evidence
verification as the web API. The output contains actual source quotations:
keep the saved file private. This is not an issuer-authentication service.

## Install

Use Python 3.11+; CI tests Python 3.12 against pinned package versions:

```bash
python -m venv .venv
# Activate: Windows .venv\Scripts\activate; Linux/macOS source .venv/bin/activate
python -m pip install -c backend/constraints-py312.txt -e './backend[dev]'
```

For other Python versions, omit the Python 3.12-specific constraints file.
Package compatibility on untested OS/runtime combinations is not guaranteed.

## Local comparison

```bash
python -m noticebridge.compare_cli original.pdf revised.pdf --output evidence.json
```

The two inputs must be readable PDF filenames and at most 10 MiB each. The
worker independently validates the PDF structure, encryption and page count.

`--output` must name a **new** `.json` path in an existing folder. No existing
file or symlink is overwritten, even if another process creates the target
after the initial preflight. The CLI stages a mode-0600 private temporary file
and attempts a same-filesystem atomic hard link with exclusive creation.
If the filesystem cannot create a hard link, it fails closed rather than
risking a partial or overwritten report. Power loss before publication can
leave a private `.noticebridge-*.tmp` file; only remove abandoned files when
no comparison is active. Avoid committing or sharing the report.

The terminal prints only finding counts, coverage and a warning. It does not
print any source PDF quotation. The saved JSON does contain those quotations,
source page references, page geometry and SHA-256 byte fingerprints.

For Windows PowerShell, run the command above on one line.

## Scriptable summary

```bash
python -m noticebridge.compare_cli original.pdf revised.pdf --output evidence.json --summary-json
```

Stdout is a short machine-readable JSON object containing fixed status-count
keys, source fingerprints, report checksum, review-task count, text coverage
and an explicit reminder that authority was not verified. It excludes
untrusted source text and PDF filenames. The full report is **never** sent to
stdout, which helps avoid accidental capture in build-system logs.

## OCR must be requested

Automatic OCR attempts bounded English/Hindi recognition of pages lacking
native text; selected OCR pages force recovery even on pages with native text.
Install Tesseract and the `eng` and `hin` language packs first.

```bash
python -m noticebridge.compare_cli original.pdf revised.pdf --output ocr.json --automatic-ocr
python -m noticebridge.compare_cli original.pdf revised.pdf --output pages.json --original-ocr-pages 1,3-5 --revised-ocr-pages 2,4
```

Page numbers are 1-based PDF page indices, not printed page labels.
At most 12 pages may be selected per document. OCR can misread or omit content
and requires direct comparison with the actual source pages. The CLI never
calls a cloud model and never enables optional local Ollama proposals: this
ensures deterministic report-replay eligibility.

## Reproduce a report

```bash
python -m noticebridge.verify_report evidence.json original.pdf revised.pdf
```

This independently checks both exact document hashes, runs the comparison
again through a fresh disposable worker, and compares all reported engine
fields and source coordinates with the saved report. Use the same NoticeBridge
version and OCR environment for the replay. Filenames can be different if
the source bytes are identical.

Neither hash verification nor replay certifies official issuer authority,
which printed column governs, or real-world interpretation accuracy.

## Operational and security limitations

- The local PDF worker has time and memory limits but is **not a complete
  untrusted-document sandbox**. Use a trusted machine or appropriate OS
  isolation before processing potentially hostile inputs.
- The CLI writes complete evidence only to the user-selected local file.
  It does not intentionally create a database, transmit PDFs, or retain PDF
  bytes after the process exits. Temporary OS buffers and files are not a
  secure-erasure guarantee.
- The output is a plain JSON file, not a cryptographic signature or legally
  authoritative result. Keep review exports and personal applicant data private.
- Existing output paths, unsupported input, bad OCR selections, worker errors,
  deadlines and non-atomic destination volumes fail without overwriting files.
- The independent source-labeled evaluation process remains necessary before
  empirical accuracy claims. Fictional test suites are regression checks only.

## Developer verification

```bash
pytest -q backend/tests/test_compare_cli.py
python -m noticebridge.compare_cli --help
```

GitHub Actions runs the CLI tests and smoke-checks argument discovery on both
Linux and Windows. The tests include a live worker round-trip, report replay,
quote-free stdout, filename checks, OCR-option boundaries and race-safe report
publication. Successful CI does not constitute a production security review.

## Multiple notice pairs

For a bounded native-text batch with pinned source bytes and replay verification,
see [local batch comparison](local-batch.md).
