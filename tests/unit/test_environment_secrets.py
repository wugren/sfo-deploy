from __future__ import annotations

import os
from pathlib import Path

import pytest

from sfo_deploy import ConfigurationError, DeploymentContext, PreflightError, ProjectBindings
from sfo_deploy.environment import (
    ActionDisposition,
    EnvironmentCheckResult,
    ExecutionOutcome,
    decide_environment_action,
    evaluate_dependencies,
    plan_environment_actions,
    resolve_environment,
)
from sfo_deploy.models import EnvironmentDefinition, EnvironmentInstance, FileSecretTarget, ScriptDefinition
from sfo_deploy.secrets import prepare_file_secret_deployments


def test_environment_decisions_cover_check_install_and_dependencies(tmp_path: Path) -> None:
    script = tmp_path / "script.py"
    script.write_text("pass\n", encoding="utf-8")
    definition = EnvironmentDefinition(
        name="db", directory=tmp_path,
        scripts=ScriptDefinition(actions={"check": (script,), "install": (script,), "configure": (script,)}),
        defaults={"port": 1}, requires_privilege=True,
    )
    resolved = resolve_environment("host", EnvironmentInstance("main", "db", "15", {"port": 2}), definition)
    actions = plan_environment_actions("deploy", definition)
    assert [action.name for action in actions] == ["check", "install", "configure"]
    assert resolved.parameters["port"] == 2 and resolved.requires_privilege
    gate = evaluate_dependencies(["host/dep"], {"host/dep": ExecutionOutcome.FAILED})
    assert decide_environment_action(actions[1], dependency_gate=gate).disposition is ActionDisposition.BLOCKED
    assert decide_environment_action(actions[1], check_result=EnvironmentCheckResult.SATISFIED).disposition is ActionDisposition.SKIP
    assert decide_environment_action(actions[1], check_result=EnvironmentCheckResult.UNSATISFIED).disposition is ActionDisposition.RUN


def test_secret_binding_is_instance_local_lazy_and_minimal(tmp_path: Path) -> None:
    secret_file = tmp_path / "key.pem"
    secret_file.write_text("private-key", encoding="utf-8")
    calls: list[str] = []
    first = ProjectBindings(
        file_secrets={"TLS_KEY": secret_file},
        config_secrets={"DB_PASSWORD": lambda: calls.append("called") or "alpha", "UNUSED": "never"},
    )
    second = ProjectBindings(config_secrets={"DB_PASSWORD": "beta"})
    assert dict(first.select_config_secrets(["DB_PASSWORD"])) == {"DB_PASSWORD": "alpha"}
    assert calls == ["called"]
    assert dict(second.select_config_secrets(["DB_PASSWORD"])) == {"DB_PASSWORD": "beta"}
    with pytest.raises(PreflightError):
        second.select_config_secrets(["MISSING"])


def test_template_rendering_escape_unknown_and_atomic_mode(tmp_path: Path) -> None:
    context = DeploymentContext(config_secrets={"DB_PASSWORD": "s3cret"}, metadata={"action": "configure"})
    assert context.render("a=$DB_PASSWORD b=${DB_PASSWORD} money=$$") == "a=s3cret b=s3cret money=$"
    with pytest.raises(ConfigurationError):
        context.render("$UNKNOWN")
    source, destination = tmp_path / "a.tpl", tmp_path / "nested" / "a.conf"
    source.write_text("password=$DB_PASSWORD", encoding="utf-8")
    context.render_template(source, destination)
    assert destination.read_text(encoding="utf-8") == "password=s3cret"
    if os.name != "nt":
        assert destination.stat().st_mode & 0o777 == 0o600


def test_deployment_context_metadata_is_recursively_read_only() -> None:
    context = DeploymentContext(
        config_secrets={"DB_PASSWORD": "secret"},
        metadata={"templates": {"app": "/tmp/app.tpl"}, "items": [{"name": "first"}]},
    )
    with pytest.raises(TypeError):
        context.metadata["templates"]["app"] = "/tmp/other.tpl"
    with pytest.raises(TypeError):
        context.metadata["items"][0]["name"] = "changed"
    with pytest.raises(AttributeError):
        context.metadata["items"].append("second")


def test_file_secret_target_validation(tmp_path: Path) -> None:
    source = tmp_path / "key"
    source.write_text("key", encoding="utf-8")
    bindings = ProjectBindings(file_secrets={"TLS_KEY": source})
    deployment = prepare_file_secret_deployments(
        [FileSecretTarget("TLS_KEY", "/etc/app/key", 0o600)], bindings
    )[0]
    assert str(deployment.destination) == "/etc/app/key"
    with pytest.raises(PreflightError):
        prepare_file_secret_deployments([FileSecretTarget("TLS_KEY", "relative", 0o600)], bindings)
    with pytest.raises(PreflightError):
        prepare_file_secret_deployments([FileSecretTarget("TLS_KEY", "/etc/app/key", 0o644)], bindings)
