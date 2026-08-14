from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


ACTIVE_TASK_SCOPE = "sfo-deploy/005-rename-to-sfo-deploy"
TASK_NAME = "005-rename-to-sfo-deploy"


def _pipeline_checker():
    scripts = Path("harness/scripts").resolve()
    sys.path.insert(0, str(scripts))
    try:
        path = scripts / "pipeline-plan-check.py"
        spec = importlib.util.spec_from_file_location("rename_pipeline_plan_check", path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(scripts))


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


def test_completion_checker_resolves_the_unique_active_task_scope(monkeypatch) -> None:
    checker = _pipeline_checker()
    monkeypatch.setattr(
        checker.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0,
            stdout=f"harness\nsfo-deploy\n{ACTIVE_TASK_SCOPE}\n",
            stderr="",
        ),
    )

    assert checker.task_scope_from_test_runner(Path.cwd(), TASK_NAME) == ACTIVE_TASK_SCOPE


@pytest.mark.parametrize(
    "listed_scopes",
    [
        ["harness", "sfo-deploy"],
        [ACTIVE_TASK_SCOPE, f"duplicate/{TASK_NAME}"],
    ],
    ids=["zero-candidates", "multiple-candidates"],
)
def test_completion_checker_fails_closed_for_non_unique_task_scope(
    monkeypatch, listed_scopes: list[str]
) -> None:
    checker = _pipeline_checker()
    monkeypatch.setattr(
        checker.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0,
            stdout="\n".join(listed_scopes) + "\n",
            stderr="",
        ),
    )

    with pytest.raises(SystemExit):
        checker.task_scope_from_test_runner(Path.cwd(), TASK_NAME)


def test_completion_artifact_targets_active_scope_not_packet_storage_scope() -> None:
    checker = _pipeline_checker()
    expected_testplan = (
        "docs/versions/v0.1/modules/"
        + "-".join(("deployment", "framework"))
        + f"/{TASK_NAME}/testplan.yaml"
    )
    artifact = {
        "schema": 1,
        "requested_module": ACTIVE_TASK_SCOPE,
        "requested_level": "all",
        "exit_code": 0,
        "testplans": [expected_testplan],
        "change_ids": ["CHG-rename-sfo-deploy"],
        "steps": [
            {
                "exit_code": 0,
                "command": ["python", "test.py"],
                "sources": [{"kind": "task-testplan"}],
            }
        ],
    }

    assert checker.is_successful_task_run(
        artifact,
        ACTIVE_TASK_SCOPE,
        expected_testplan,
        {"CHG-rename-sfo-deploy"},
    )
    packet_storage_scope = (
        "-".join(("deployment", "framework")) + f"/{TASK_NAME}"
    )
    assert not checker.is_successful_task_run(
        artifact,
        packet_storage_scope,
        expected_testplan,
        {"CHG-rename-sfo-deploy"},
    )
    packet_scoped_artifact = {**artifact, "requested_module": packet_storage_scope}
    assert not checker.is_successful_task_run(
        packet_scoped_artifact,
        ACTIVE_TASK_SCOPE,
        expected_testplan,
        {"CHG-rename-sfo-deploy"},
    )
