"""Resource limits must be applied only in the disposable worker."""

import os

import pytest

from noticebridge import worker_limits


@pytest.mark.skipif(os.name != "posix", reason="POSIX resource module is required")
def test_worker_limits_are_bounded_and_do_not_raise_inherited_ceiling(monkeypatch):
    import resource

    calls: list[tuple[int, tuple[int, int]]] = []
    monkeypatch.setattr(resource, "getrlimit", lambda _: (800, 500))
    monkeypatch.setattr(resource, "setrlimit", lambda kind, limits: calls.append(
        (kind, limits)
    ))
    worker_limits.apply_worker_limits(enable_ocr=False)
    assert calls
    assert all(soft <= 500 and hard == 500 for _, (soft, hard) in calls)
    assert any(kind == resource.RLIMIT_CORE and soft == 0 for kind, (soft, _) in calls)


@pytest.mark.skipif(os.name != "posix", reason="POSIX resource module is required")
def test_ocr_has_a_separate_cpu_budget(monkeypatch):
    import resource

    calls: list[tuple[int, tuple[int, int]]] = []
    monkeypatch.setattr(resource, "getrlimit", lambda _: (resource.RLIM_INFINITY, -1))
    monkeypatch.setattr(resource, "setrlimit", lambda kind, limits: calls.append(
        (kind, limits)
    ))
    worker_limits.apply_worker_limits(enable_ocr=True)
    assert (resource.RLIMIT_CPU, (worker_limits.OCR_CPU_SECONDS, -1)) in calls


def test_linux_memory_budget_is_explicit():
    assert worker_limits.WORKER_MEMORY_BYTES == 2 * 1024**3
