"""Best-effort POSIX resource ceilings for disposable PDF workers.

This is NOT a sandbox. It cannot stop every native parser exploit or stop
subprocesses on Windows. Use containers/seccomp/job objects for public hosting.
"""

import os

if os.name == "posix":
    import resource

WORKER_MEMORY_BYTES = 2 * 1024 * 1024 * 1024
WORKER_MAX_FILE_BYTES = 64 * 1024 * 1024
WORKER_MAX_OPEN_FILES = 128
NATIVE_CPU_SECONDS = 70
OCR_CPU_SECONDS = 180


def _cap_soft_limit(kind: int, requested: int) -> bool:
    """Lower the soft limit without increasing any inherited limit."""
    soft, hard = resource.getrlimit(kind)
    infinity = resource.RLIM_INFINITY
    target = requested if soft == infinity else min(soft, requested)
    if hard != infinity:
        target = min(target, hard)
    try:
        resource.setrlimit(kind, (target, hard))
        return True
    except (OSError, ValueError):
        # Some POSIX environments reject particular limits; the parent still
        # enforces a wall-clock deadline and terminates the process group.
        return False


def apply_worker_limits(*, enable_ocr: bool) -> None:
    """Apply limits only to a fresh worker, never the FastAPI server."""
    if os.name != "posix":
        return
    _cap_soft_limit(resource.RLIMIT_CORE, 0)
    _cap_soft_limit(resource.RLIMIT_FSIZE, WORKER_MAX_FILE_BYTES)
    _cap_soft_limit(resource.RLIMIT_NOFILE, WORKER_MAX_OPEN_FILES)
    _cap_soft_limit(
        resource.RLIMIT_CPU, OCR_CPU_SECONDS if enable_ocr else NATIVE_CPU_SECONDS
    )
    # RLIMIT_AS is most predictable on Linux; it can be unreliable on macOS.
    if sys_platform_is_linux():
        _cap_soft_limit(resource.RLIMIT_AS, WORKER_MEMORY_BYTES)


def sys_platform_is_linux() -> bool:
    """Kept separate for precise platform tests."""
    import sys

    return sys.platform.startswith("linux")
