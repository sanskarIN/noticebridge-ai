# NoticeBridge AI — security threat model and release gate

**Status:** development threat review (23 November 2026), not a security certification. **Do not expose this prototype as an unprotected public PDF upload service.**

## Trust boundaries

1. **Browser → API:** Users submit two PDFs over the local development network. The browser preview uses bundled PDF.js; documents are never deliberately transmitted to an external preview CDN.
2. **API → worker:** Untrusted PDF bytes cross into a disposable subprocess, which parses them using native PyMuPDF and optionally Tesseract. Process separation is not a complete sandbox.
3. **Worker → API report:** The parent checks the reported hashes against submitted bytes and validates page indices, source roles, review tasks and claims; it does not independently verify issuer identity or reparse every quotation.
4. **Worker → loopback local AI:** Only when opted in, bounded unmatched passages are sent to the fixed local Ollama endpoint on 127.0.0.1:11434. The response is capped and checked; model proposals are always additive and unverified.
5. **API → UI/export:** Findings, JSON and review CSV exports may contain personal or sensitive passages. Exports are generated locally in the browser and are not proof of official authority. Do not upload confidential records to an untrusted host or share exported files without checking content.

## Implemented controls and residual risks

| Control | Current safeguard | Remaining exposure |
| --- | --- | --- |
| Multipart | 10 MiB per PDF; 21 MiB aggregate request; 1 MiB in-memory spool before temporary-disk rollover. Storage open/write/seek failures now return a controlled 503 and request slots are released; disconnects close temporary upload spools | External proxy abuse, storage quotas, OS-level cleanup guarantees |
| Cross-site browser uploads | Exact browser `Origin` allowlist for local frontend/API origins; if `Origin` is absent, reject `Sec-Fetch-Site: cross-site` and unexpected/duplicate fetch-metadata headers. Reject before consuming/spooling a POST upload. CORS remains in place for response reads | Not authentication or CSRF tokens: native clients can forge headers; older browsers without both headers may not be covered; deployed origins need explicit secure configuration |
| Streaming | 90-second receive deadline; maximum 8 simultaneous compare requests per API process | Cross-process abuse, volumetric attacks and network rate limiting |
| PDFs | Reject encrypted PDFs and excessive page, line or text counts | Native parser vulnerabilities, decompression bombs |
| OCR | Explicit opt-in, 12-page limit, 16M estimated render pixels per page | Inaccurate transcription, external tool exploitation |
| Worker | Disposable subprocess; timeouts; restricted inherited environment; best-effort Linux/POSIX limits; Windows Job Object kill-on-close with 2 GiB memory ceiling and max eight worker-tree processes; unexpected process-I/O errors trigger kill/reap before return | Native PDF parser vulnerabilities, Windows process pre-assignment startup, full OS confinement and host CPU/disk quotas |
| Result | Private file-backed worker stdout, parent reads at most 64 MiB + one byte | Disk usage without OS quotas |
| Evidence | Byte SHA-256, source-page metadata, human-review gate, independent structural integrity checks, fixed bilingual explanation/checklist templates, recomputed source-text similarity, and allowlisted source-aware warning grammar | Fake issuer, altered source documents, incomplete quotation re-extraction, unsafe interpretation |
| Local AI | Loopback-only URL, no HTTP proxy environment, 64 KiB streaming HTTP response limit, same-category source references | Prompt injection and false semantic relationships |
| Browser | Local PDF.js, bounded canvas bitmap, keyboard-accessible preview; CSV cells quoted and spreadsheet formula starters neutralized; user review-state export labeled separately from authority validation | Browser/plugin vulnerabilities, spreadsheet-specific interpretation and incomplete accessibility |
| Response | No-store and nosniff response headers | Intermediate infrastructure logs and screenshots |

Temporary OS files can exist while receiving/parsing uploads or capturing worker output. The application does not intentionally persist submitted PDFs in a database, but that is not a secure-erasure guarantee.

## Risk register

- **P0 — Public hostile PDF processing:** Require OS or container confinement, unprivileged credentials, filesystem/network restrictions, CPU/RAM/disk quotas, monitoring, and incident procedures before exposing a public endpoint.
- **P0 — Windows descendants:** Windows Job Object integration and a live child-process shutdown test are implemented; verify the exact commit's Windows CI, then complete an independent Windows 11 manual run, including OCR child-process cancellation. A Windows worker is launched before assignment but cannot receive PDF bytes until assignment succeeds. This is not atomic job-at-create containment.
- **P0 — Misleading notices:** Never present upload order, OCR transcription or a local AI suggestion as proof that an issuing organization approved a change.
- **P1 — Temporary-file retention:** Audit cleanup after normal requests, malformed PDFs, client disconnects and timeouts; use protected temp directories and storage quotas.
- **P1 — Service resource exhaustion:** Test concurrent uploads, slow requests, oversized chunks, runaway workers and reverse-proxy controls. The local browser-origin guard reduces drive-by website submissions; it does not block scripted HTTP clients or replace network authentication/rate limiting.
- **P1 — Dependency drift:** npm uses a committed integrity-bearing lockfile and `npm ci`. Python 3.12 CI installs from version constraints captured from a previously successful Linux/Windows run and verifies the installed versions. Python wheel hashes, Python 3.11/3.13 and OS-specific transitive resolution, dependency advisories, and CI Action pins still require review.
- **P1 — Model response manipulation:** Retain unverified proposals and their deterministic unmatched evidence, and test malicious instructions embedded in source text.
- **P2 — Document geometry and OCR:** Independently evaluate rotated/cropped PDFs, Hindi OCR quality, and missing-page coverage.

## Release review

A release-candidate review must confirm the exact head commit has passing Linux and Windows backend tests, frontend build, and browser tests; realistic independent evaluation labels; documented failure examples; actual Windows process-tree termination; temporary-file cleanup; and an approved hosting plan. CI passing does not certify production security or legal accuracy.

**No merging, release tagging, deployment, or Devpost submission without explicit user authorization.**
