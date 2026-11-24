# Independent review workbench

An English-first, dependency-free static utility for manually preparing pinned
human review labels. It does not contact the comparison API or an AI model.
The tool is separate from the public comparison application.

## Start locally

From the repository root:

```sh
python -m http.server 8765 --bind 127.0.0.1 --directory tools/review-workbench
```

Open http://127.0.0.1:8765/index.html using an up-to-date Chrome or Edge.
Serve only the workbench folder. Keep private corpus PDFs outside it; select
them through the browser file picker, never through the HTTP server.

Load the blank version-2 manifest in example/source.json and select the
matching fictional PDFs. Both SHA-256 checks must pass. Open the verified
documents in your browser's PDF viewer and manually enter page numbers and
source quotations. Complete each case after inspecting both documents;
a legitimate zero-pair case is permitted. Save incomplete work with the
separate draft format, or export finished review JSON after every case
is explicitly completed. Resuming a draft requires fresh verification and
review confirmation. Do not import another reviewer's labels.

For real corpora follow [the independent evaluation guide](../../docs/labeled-evaluation.md).
Store the exported JSON alongside the private source set and use the backend
review checker, reconciliation and native quotation audit. These checks do
not authenticate reviewer independence or verify official authority.

## Automated tests

From the repository root with Node 22 and the backend installed:

```sh
node --test tools/review-workbench/core.test.cjs
python tools/review-workbench/test_interop.py --repo .
```

With the frontend dependencies installed and Chromium installed through the
existing Playwright setup:

```sh
node tools/review-workbench/test_browser.cjs
```

The core tests exercise SHA-256, strict JSON and Unicode handling, draft
restoration, completion and navigation. The interop script uses the exact
fictional PDFs and invokes the repository review checker and quote audit when
--repo is supplied. The browser smoke test uses real loopback navigation,
native WebCrypto and downloads, not a mocked hashing bridge. It does not
assert native PDF viewer rendering. The sample labels are regression fixtures,
not real-world or independently reviewed accuracy evidence.

No private corpus data, model outputs or real reviewer labels should be
committed to this directory.
