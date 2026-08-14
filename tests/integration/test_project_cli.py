from __future__ import annotations

import json
from pathlib import Path

import pytest

from sfo_deploy import ProjectBindings, create_cli
from sfo_deploy.cli import make_entrypoint
from sfo_deploy.downloads import DownloadProviderRegistry, DownloadRequest, VerifiedArtifact
from sfo_deploy.models import ExecutionPlan
from sfo_deploy.results import DeploymentResult

from conftest import write_cluster


def test_bound_cli_works_from_arbitrary_cwd_and_instances_are_isolated(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    first_root, second_root = tmp_path / "first", tmp_path / "second"
    write_cluster(first_root)
    write_cluster(second_root, name="staging")
    first = create_cli(config_root=first_root, config_secrets={"DB_PASSWORD": "first"})
    second = create_cli(config_root=second_root, config_secrets={"DB_PASSWORD": "second"})
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    assert first(["validate", "--cluster", "production"]) == 0
    assert json.loads(capsys.readouterr().out)["cluster"] == "production"
    assert second(["validate", "--cluster", "staging"]) == 0
    assert json.loads(capsys.readouterr().out)["cluster"] == "production"


def test_cli_plan_is_secret_free_and_exit_codes_are_stable(cluster_root: Path, capsys) -> None:
    cli = create_cli(config_root=cluster_root, config_secrets={"DB_PASSWORD": "do-not-print"})
    assert cli(["plan", "--cluster", "production", "--app", "backend"]) == 0
    output = capsys.readouterr().out
    assert "do-not-print" not in output
    assert "DB_PASSWORD" in output
    assert cli(["validate", "--cluster", "missing"]) == 2
    error = json.loads(capsys.readouterr().err)
    assert error["error"]["category"] == "configuration"
    assert cli(["invalid", "--cluster", "production"]) == 2


def test_bound_cli_does_not_accept_config_root(cluster_root: Path) -> None:
    cli = create_cli(config_root=cluster_root)
    assert cli(["validate", "--config-root", str(cluster_root), "--cluster", "production"]) == 2


class _UnusedProvider:
    def fetch(self, request: DownloadRequest, destination: Path) -> VerifiedArtifact:
        raise AssertionError("CLI 规划测试不应下载包")


def _environment_cli(cluster_root: Path, *, generic: bool):
    providers = DownloadProviderRegistry({"memory": _UnusedProvider()})
    if generic:
        return make_entrypoint(
            config_root=None,
            bindings=ProjectBindings(),
            download_providers=providers,
        )
    return create_cli(
        config_root=cluster_root,
        download_providers={"memory": _UnusedProvider()},
    )


@pytest.mark.parametrize("generic", [False, True], ids=["bound", "generic"])
@pytest.mark.parametrize("action", ["check", "install"])
def test_environment_only_cli_actions_are_reachable_and_plan_one_step(
    cluster_root: Path, monkeypatch, capsys, generic: bool, action: str
) -> None:
    captured: list[ExecutionPlan] = []

    def capture(plan: ExecutionPlan, *args, **kwargs) -> DeploymentResult:
        captured.append(plan)
        return DeploymentResult(plan.cluster, plan.requested_action, ())

    monkeypatch.setattr("sfo_deploy.integration.execute_plan", capture)
    cli = _environment_cli(cluster_root, generic=generic)
    arguments = [action, "--cluster", "production", "--environment", "east-host/db"]
    if generic:
        arguments[1:1] = ["--config-root", str(cluster_root)]

    assert cli(arguments) == 0
    capsys.readouterr()
    assert len(captured) == 1
    assert [step.id for step in captured[0].steps] == [f"env:east-host/db:{action}"]
    assert all(step.kind == "environment" for step in captured[0].steps)


@pytest.mark.parametrize("generic", [False, True], ids=["bound", "generic"])
@pytest.mark.parametrize("action", ["check", "install"])
@pytest.mark.parametrize(
    "selection",
    [[], ["--environment", "east-host/db", "--app", "backend"]],
    ids=["missing-environment", "app-conflict"],
)
def test_environment_only_cli_actions_reject_ambiguous_selection(
    cluster_root: Path, capsys, generic: bool, action: str, selection: list[str]
) -> None:
    cli = _environment_cli(cluster_root, generic=generic)
    arguments = [action, "--cluster", "production", *selection]
    if generic:
        arguments[1:1] = ["--config-root", str(cluster_root)]

    assert cli(arguments) == 2
    error = json.loads(capsys.readouterr().err)
    assert error["error"]["category"] == "configuration"
