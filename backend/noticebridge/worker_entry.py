"""Subprocess bootstrap: apply POSIX limits before importing the PDF parser."""

import sys

from .worker_limits import apply_worker_limits


def main() -> int:
    if sys.argv[1:] not in (["--native"], ["--ocr"]):
        return 2
    apply_worker_limits(enable_ocr=sys.argv[1] == "--ocr")
    # Import PDF dependencies only after applying process limits.
    from .worker import main as run_worker

    return run_worker()


if __name__ == "__main__":
    raise SystemExit(main())
