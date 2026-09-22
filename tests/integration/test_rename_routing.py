from __future__ import annotations

import subprocess
import sys


ACTIVE_TASK_SCOPE = "sfo-deploy/005-rename-to-sfo-deploy"


def test_unified_runner_lists_the_active_sfo_task_route() -> None:
    completed = subprocess.run(
        [sys.executable, "harness/scripts/test-run.py", "ignored", "all", "--list"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    assert completed.returncode == 0, completed.stderr
    assert ACTIVE_TASK_SCOPE in completed.stdout.splitlines()
