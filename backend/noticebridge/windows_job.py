"""Windows Job Object lifetime for a disposable PDF/OCR worker.

No untrusted PDF data is written to the subprocess stdin until its process is
successfully assigned to the job. Closing the final job handle terminates
remaining descendants. This is resource control, not a full security sandbox.
"""

import ctypes
import os
from ctypes import wintypes

# Microsoft Win32: JOB_OBJECT_LIMIT_* and JobObjectExtendedLimitInformation.
KILL_ON_CLOSE = 0x00002000
ACTIVE_PROCESS_LIMIT = 0x00000008
PROCESS_MEMORY_LIMIT = 0x00000100
JOB_MEMORY_LIMIT = 0x00000200
EXTENDED_LIMIT_INFORMATION = 9
PROCESS_SET_QUOTA = 0x0100
PROCESS_TERMINATE = 0x0001
WORKER_MEMORY_LIMIT = 2 * 1024**3
MAX_JOB_PROCESSES = 8


class _BasicLimits(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _IoCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimits),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def _win32():
    """Bind only the Win32 APIs needed for job ownership."""
    if os.name != "nt":
        raise RuntimeError("Windows process jobs are only available on Windows")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
    kernel.CreateJobObjectW.restype = ctypes.c_void_p
    kernel.SetInformationJobObject.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
    ]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.TerminateJobObject.argtypes = [ctypes.c_void_p, wintypes.UINT]
    kernel.TerminateJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.CloseHandle.restype = wintypes.BOOL
    return kernel


def _failure(operation: str) -> OSError:
    return OSError(ctypes.get_last_error(), f"Windows {operation} failed")


class WindowsWorkerJob:
    """Own a kill-on-close job containing exactly one worker tree.

    The initial Python child exists before assignment, but it cannot read
    untrusted PDF bytes until the caller starts communicate(). If assignment
    fails, the caller must kill and reap the unassigned worker.
    """

    def __init__(self, pid: int):
        api = _win32()
        job = api.CreateJobObjectW(None, None)
        if not job:
            raise _failure("CreateJobObjectW")
        try:
            settings = _ExtendedLimits()
            settings.BasicLimitInformation.LimitFlags = (
                KILL_ON_CLOSE | ACTIVE_PROCESS_LIMIT
                | PROCESS_MEMORY_LIMIT | JOB_MEMORY_LIMIT
            )
            settings.BasicLimitInformation.ActiveProcessLimit = MAX_JOB_PROCESSES
            settings.ProcessMemoryLimit = WORKER_MEMORY_LIMIT
            settings.JobMemoryLimit = WORKER_MEMORY_LIMIT
            if not api.SetInformationJobObject(
                job, EXTENDED_LIMIT_INFORMATION,
                ctypes.byref(settings), ctypes.sizeof(settings),
            ):
                raise _failure("SetInformationJobObject")

            process = api.OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid,
            )
            if not process:
                raise _failure("OpenProcess")
            try:
                if not api.AssignProcessToJobObject(job, process):
                    raise _failure("AssignProcessToJobObject")
            finally:
                api.CloseHandle(process)
        except BaseException:
            api.CloseHandle(job)
            raise
        self._api = api
        self._handle = job

    def terminate(self) -> bool:
        """Stop the entire worker tree (including OCR descendants)."""
        return bool(
            self._handle and self._api.TerminateJobObject(self._handle, 1)
        )

    def close(self) -> None:
        """Close the last owner handle to terminate leftover descendants."""
        if self._handle:
            handle = self._handle
            self._handle = None
            self._api.CloseHandle(handle)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()
        return False
