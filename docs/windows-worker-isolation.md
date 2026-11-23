# Windows 11 PDF worker isolation — development verification

**Status:** Implemented on the draft feature branch; production-sandbox certification **not** implied.

## How it works

The API starts a disposable Python worker with stdin closed to untrusted PDF input until setup completes. On Windows, the parent opens a private Job Object and applies:

- Kill-on-close, so the worker and still-running descendants terminate when the last job handle closes.
- Maximum **eight simultaneous child processes** within that worker's job.
- **2 GiB committed-memory ceiling** for the job as well as individual member processes.
- No breakaway permission in the job flags.

Only when assignment succeeds does the parent call subprocess communication with the uploaded PDFs. If job creation, limit setup, or assignment fails, the parent terminates and reaps the worker, and returns an error rather than parsing without containment. On timeout, the parent terminates the job, not just the original Python process. On normal completion the job handle closes, cleaning up potential descendants.

The job attachment is performed immediately after subprocess creation, **not atomically at process creation**. The child Python interpreter can start before assignment, but no uploaded PDF bytes are provided before attachment. This does not protect against arbitrary pre-assignment code execution in the interpreter or other host-level threats.

Native implementation: backend/noticebridge/windows_job.py. Parent lifecycle: backend/noticebridge/isolation.py.

## Verification commands (Windows PowerShell)

From a clean repository checkout, after installing Python 3.12 and Rust/Node tools only if separately required:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e "./backend[dev]"
python -m pytest -q backend/tests/test_windows_job.py
python -m pytest -q backend/tests/test_isolation.py backend/tests/test_provenance.py
python -m pytest -q backend/tests
python -m ruff check backend
```

The live Windows test creates an ordinary sleeping Python child after job assignment, confirms it is running, closes the Job Object, and checks that the operating system signals the child as terminated. The test always attempts to clean up the child even when an assertion fails. Fake-worker tests also verify failure cleanup and timeout termination.

**Manual acceptance checklist (not completed by CI alone):**

- [ ] Run a genuine pair of fictional PDFs in the app using Windows 11.
- [ ] Confirm the Windows worker successfully assigns to its job before receiving data; a job assignment failure must result in a safe API error.
- [ ] Run the live process-tree test on the actual Windows desktop and record OS build and Python version.
- [ ] Force an OCR worker timeout with an isolated fictional fixture and verify descendants do not remain.
- [ ] Inspect temporary directory cleanup after normal, oversized, malformed and timed-out requests.
- [ ] Verify installed Tesseract eng/hin availability, or explicitly record skipped integration tests.
- [ ] Review memory/process caps and Windows event logs without recording sensitive PDF content.

Windows Job Objects provide process-tree lifecycle and some resource limits, not a low-privilege sandbox, filesystem isolation, anti-malware boundary, CPU/disk confinement, or authentication. **Do not expose raw PDF uploads to the public Internet without further isolation.**

Official API documentation:
- https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject
- https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information
