"""Live Windows Job Object regression coverage for disposable worker trees."""

import os
import subprocess
import sys

import pytest

from noticebridge.windows_job import (
    ACTIVE_PROCESS_LIMIT,
    JOB_MEMORY_LIMIT,
    KILL_ON_CLOSE,
    MAX_JOB_PROCESSES,
    PROCESS_MEMORY_LIMIT,
    WORKER_MEMORY_LIMIT,
    WindowsWorkerJob,
)


def test_job_contract_declares_kill_on_close_and_resource_limits():
    assert KILL_ON_CLOSE == 0x2000
    assert ACTIVE_PROCESS_LIMIT == 0x8
    assert PROCESS_MEMORY_LIMIT == 0x100
    assert JOB_MEMORY_LIMIT == 0x200
    assert MAX_JOB_PROCESSES == 8
    assert WORKER_MEMORY_LIMIT == 2 * 1024**3


@pytest.mark.skipif(os.name != "nt", reason="requires the live Windows API")
def test_closing_job_terminates_worker_descendants():
    """A worker launches a child only after assignment; closing job kills it."""
    import ctypes
    from ctypes import wintypes

    # No malicious PDFs. Child sleeps long enough to prove its job lifetime
    # is controlled by the parent even after the original worker has exited.
    script = (
        "import subprocess,sys;"
        "sys.stdin.buffer.read(1);"
        "child=subprocess.Popen([sys.executable,'-c',"
        "'import time;time.sleep(30)'],"
        "stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,"
        "stderr=subprocess.DEVNULL);"
        "print(child.pid,flush=True)"
    )
    process = subprocess.Popen(
        [sys.executable, "-c", script],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    job = None
    child_handle = None
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.TerminateProcess.argtypes = [ctypes.c_void_p, wintypes.UINT]
    kernel.TerminateProcess.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.CloseHandle.restype = wintypes.BOOL
    try:
        job = WindowsWorkerJob(process.pid)
        stdout, stderr = process.communicate(input=b"1", timeout=15)
        assert process.returncode == 0, stderr
        child_pid = int(stdout.strip())
        # SYNCHRONIZE | PROCESS_TERMINATE for reliable wait and cleanup.
        child_handle = kernel.OpenProcess(0x00100000 | 0x0001, False, child_pid)
        assert child_handle, f"Unable to open the test child {child_pid}"
        assert kernel.WaitForSingleObject(child_handle, 0) == 258  # WAIT_TIMEOUT
        job.close()
        assert kernel.WaitForSingleObject(child_handle, 5000) == 0
    finally:
        if job is not None:
            job.close()
        if child_handle:
            if kernel.WaitForSingleObject(child_handle, 0) == 258:
                kernel.TerminateProcess(child_handle, 1)
            kernel.CloseHandle(child_handle)
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)


@pytest.mark.skipif(os.name != "nt", reason="requires Windows job assignment path")
@pytest.mark.parametrize("failure", [OSError, RuntimeError, ValueError])
def test_failed_job_assignment_never_leaves_worker_running(monkeypatch, failure):
    import noticebridge.isolation as isolation

    class FakeWorker:
        pid = 7777

        def __init__(self):
            self.killed = False
            self.reaped = False

        def kill(self):
            self.killed = True

        def communicate(self, **kwargs):
            assert kwargs == {"timeout": 2}
            self.reaped = True
            return None, None

    def deny_assignment(pid):
        raise failure("simulated denied job assignment")

    process = FakeWorker()
    monkeypatch.setattr(isolation, "WindowsWorkerJob", deny_assignment)
    with pytest.raises(
        isolation.ProcessingFailed, match="containment unavailable"
    ):
        isolation._attach_windows_job(process)
    assert process.killed
    assert process.reaped


@pytest.mark.skipif(os.name != "nt", reason="requires the Windows structure ABI")
def test_extended_job_limits_match_native_windows_64bit_layout():
    import ctypes

    from noticebridge.windows_job import _ExtendedLimits

    # Structures must agree with the Windows SDK ABI, otherwise a successful
    # SetInformationJobObject could apply the wrong limits.
    assert ctypes.sizeof(ctypes.c_void_p) == 8
    assert ctypes.sizeof(_ExtendedLimits) == 144

