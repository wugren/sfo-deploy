from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path, PurePosixPath

from sfo_deploy.downloads import DownloadProviderRegistry, DownloadRequest, VerifiedArtifact
from sfo_deploy.execution import execute_plan
from sfo_deploy.models import ConfigTemplate, ExecutionPlan, FileSecretTarget, Machine, PackageSpec, PlanStep, ResolvedMachine
from sfo_deploy.results import CommandResult, StepStatus
from sfo_deploy.secrets import ProjectBindings


class MemoryProvider:
    def fetch(self, request: DownloadRequest, destination: Path) -> VerifiedArtifact:
        payload = b"sfo-deploy-test-package"
        destination.write_bytes(payload)
        return VerifiedArtifact(destination, "sha256", hashlib.sha256(payload).hexdigest(), len(payload))


class FakeSession:
    def __init__(self, codes: list[int] | None = None, *, fail_preflight: bool = False, fail_cleanup: bool = False) -> None:
        self.codes = list(codes or [])
        self.fail_preflight = fail_preflight
        self.fail_cleanup = fail_cleanup
        self.events: list[object] = []
        self.uploaded: dict[str, bytes] = {}
        self.file_secrets: list[object] = []

    def create_workspace(self) -> PurePosixPath:
        self.events.append("workspace")
        return PurePosixPath("/tmp/deploy")

    def upload_file(self, source: Path, destination: PurePosixPath, *, mode: int = 0o600) -> None:
        self.events.append(("upload", str(destination), mode))
        self.uploaded[str(destination)] = source.read_bytes()

    def deploy_file_secret(self, deployment: object, *, workspace: PurePosixPath) -> None:
        self.events.append(("file-secret", getattr(deployment, "name"), str(workspace)))
        self.file_secrets.append(deployment)

    def preflight_python(self, interpreter: str) -> CommandResult:
        self.events.append(("python", interpreter))
        if self.fail_preflight:
            from sfo_deploy import PreflightError
            raise PreflightError("python unavailable")
        return CommandResult(0)

    def preflight_privilege(self) -> None:
        self.events.append("privilege")

    def execute_python(self, interpreter: str, script: PurePosixPath, *, context_path: PurePosixPath, privileged: bool = False) -> CommandResult:
        self.events.append(("execute", str(script), str(context_path), privileged))
        code = self.codes.pop(0) if self.codes else 0
        return CommandResult(code, stdout="secret-value", stderr="secret-value")

    def remove_file(self, path: PurePosixPath) -> None:
        self.events.append(("remove", str(path)))

    def cleanup_workspace(self, path: PurePosixPath) -> None:
        self.events.append(("cleanup", str(path)))
        if self.fail_cleanup:
            raise RuntimeError("cleanup failed")

    def close(self) -> None:
        self.events.append("close")


class FakeTransport:
    def __init__(self, sessions: dict[str, FakeSession]) -> None:
        self.sessions = sessions
        self.connected: list[str] = []

    def connect(self, target: ResolvedMachine) -> FakeSession:
        name = target.machine.name
        self.connected.append(name)
        return self.sessions[name]


def machine(name: str) -> ResolvedMachine:
    return ResolvedMachine(Machine(name, (), "10.0.0.1", "203.0.113.1", "east", "deploy"), "10.0.0.1", "private")


def script(tmp_path: Path, name: str) -> Path:
    path = tmp_path / name
    path.write_text("print('ok')\n", encoding="utf-8")
    return path


def step(tmp_path: Path, id: str, host: str, action: str, *, kind: str = "app", depends_on: tuple[str, ...] = (), secrets: bool = False, package: bool = False) -> PlanStep:
    package_spec = PackageSpec("memory", {"key": "x"}, "sha256", hashlib.sha256(b"sfo-deploy-test-package").hexdigest()) if package else None
    return PlanStep(
        id=id, machine=machine(host), kind=kind, resource="resource", action=action,
        scripts=(script(tmp_path, id.replace(":", "-").replace("/", "-") + ".py"),), parameters={"requires_privilege": secrets},
        package=package_spec, config_secrets=("DB_PASSWORD",) if secrets else (),
        file_secrets=(FileSecretTarget("TLS_KEY", "/etc/app/key"),) if secrets else (), depends_on=depends_on,
    )


def test_check_unsatisfied_runs_install_and_satisfied_skips(tmp_path: Path) -> None:
    check = step(tmp_path, "env:a/db:check", "a", "check", kind="environment")
    install = step(tmp_path, "env:a/db:install", "a", "install", kind="environment", depends_on=(check.id,), package=True)
    configure = step(tmp_path, "env:a/db:configure", "a", "configure", kind="environment", depends_on=(install.id,))
    session = FakeSession([1, 0, 0])
    result = execute_plan(ExecutionPlan("c", "deploy", (check, install, configure)), FakeTransport({"a": session}), download_providers=DownloadProviderRegistry({"memory": MemoryProvider()}))
    assert [item.status for item in result.steps] == [StepStatus.SUCCEEDED] * 3
    assert any(event[0] == "execute" for event in session.events if isinstance(event, tuple))

    session = FakeSession([0, 0])
    result = execute_plan(ExecutionPlan("c", "deploy", (check, install, configure)), FakeTransport({"a": session}), download_providers=DownloadProviderRegistry({"memory": MemoryProvider()}))
    assert result.steps[1].skip_reason == "check-satisfied"


def test_check_only_unsatisfied_blocks_targeted_app(tmp_path: Path) -> None:
    check = step(tmp_path, "env:a/db:check", "a", "check", kind="environment")
    app = step(
        tmp_path,
        "app:a/backend:configure",
        "a",
        "configure",
        depends_on=(check.id,),
    )
    session = FakeSession([1])
    result = execute_plan(ExecutionPlan("c", "deploy", (check, app)), FakeTransport({"a": session}))
    assert result.steps[0].status is StepStatus.FAILED
    assert result.steps[1].status is StepStatus.BLOCKED
    assert result.steps[1].skip_reason == "dependency-failed"
    assert len([event for event in session.events if isinstance(event, tuple) and event[0] == "execute"]) == 1


def test_target_fail_fast_independent_host_continues_and_exit_code(tmp_path: Path) -> None:
    a1 = step(tmp_path, "app:a/x:configure", "a", "configure")
    a2 = step(tmp_path, "app:a/x:deploy", "a", "deploy", depends_on=(a1.id,))
    b1 = step(tmp_path, "app:b/x:configure", "b", "configure")
    transport = FakeTransport({"a": FakeSession([7]), "b": FakeSession([0])})
    result = execute_plan(ExecutionPlan("c", "deploy", (a1, a2, b1)), transport)
    assert result.exit_code == 4
    assert result.steps[0].status is StepStatus.FAILED
    assert result.steps[1].skip_reason == "target-fail-fast"
    assert result.steps[2].status is StepStatus.SUCCEEDED
    assert transport.connected == ["a", "b"]


def test_preflight_and_cleanup_failures_have_stable_exit_semantics(tmp_path: Path) -> None:
    only = step(tmp_path, "app:a/x:start", "a", "start")
    result = execute_plan(ExecutionPlan("c", "start", (only,)), FakeTransport({"a": FakeSession(fail_preflight=True)}))
    assert result.exit_code == 3 and result.steps[0].error_category == "preflight"
    result = execute_plan(ExecutionPlan("c", "start", (only,)), FakeTransport({"a": FakeSession(fail_cleanup=True)}))
    assert result.exit_code == 4 and result.steps[0].cleanup_errors


def test_secret_delivery_context_minimization_cleanup_and_redaction(tmp_path: Path) -> None:
    key = tmp_path / "key.pem"
    key.write_text("file-secret", encoding="utf-8")
    configure = step(tmp_path, "app:a/x:configure", "a", "configure", secrets=True)
    session = FakeSession([0])
    result = execute_plan(
        ExecutionPlan("c", "configure", (configure,)), FakeTransport({"a": session}),
        bindings=ProjectBindings(file_secrets={"TLS_KEY": key}, config_secrets={"DB_PASSWORD": "secret-value", "UNUSED": "not-sent"}),
    )
    contexts = [json.loads(value) for name, value in session.uploaded.items() if "context-" in name]
    assert contexts[0]["config_secrets"] == {"DB_PASSWORD": "secret-value"}
    assert "secret-value" not in result.steps[0].stdout + result.steps[0].stderr
    assert len(session.file_secrets) == 1
    assert any(event[0] == "remove" for event in session.events if isinstance(event, tuple))


def test_remote_runtime_is_uploaded_once_per_session_before_user_scripts_and_cleaned(
    tmp_path: Path,
) -> None:
    first = step(tmp_path, "app:a/x:start", "a", "start")
    second = step(tmp_path, "app:a/x:restart", "a", "restart")
    third = step(tmp_path, "app:b/x:start", "b", "start")
    sessions = {"a": FakeSession([0, 0]), "b": FakeSession([0])}

    result = execute_plan(
        ExecutionPlan("c", "start", (first, second, third)),
        FakeTransport(sessions),
    )

    assert result.succeeded
    for session in sessions.values():
        runtime_uploads = [
            (index, event)
            for index, event in enumerate(session.events)
            if isinstance(event, tuple)
            and event[0] == "upload"
            and event[1] == "/tmp/deploy/sfo_deploy.py"
        ]
        script_uploads = [
            index
            for index, event in enumerate(session.events)
            if isinstance(event, tuple)
            and event[0] == "upload"
            and "/script-" in event[1]
        ]
        execute_events = [
            index
            for index, event in enumerate(session.events)
            if isinstance(event, tuple) and event[0] == "execute"
        ]
        cleanup_index = session.events.index(("cleanup", "/tmp/deploy"))
        assert len(runtime_uploads) == 1
        assert runtime_uploads[0][1][2] == 0o600
        assert runtime_uploads[0][0] < min(script_uploads) < min(execute_events)
        assert cleanup_index > max(execute_events)


def test_only_configure_uploads_declared_templates_and_context_stays_minimal(
    tmp_path: Path,
) -> None:
    key = tmp_path / "key.pem"
    key.write_text("file-secret", encoding="utf-8")
    template = tmp_path / "app.conf.tpl"
    template.write_text("password=$DB_PASSWORD", encoding="utf-8")
    declared = (ConfigTemplate("templates/app.conf.tpl", template),)
    configure = replace(
        step(tmp_path, "app:a/x:configure", "a", "configure", secrets=True),
        templates=declared,
    )
    start = replace(
        step(
            tmp_path,
            "app:a/x:start",
            "a",
            "start",
            depends_on=(configure.id,),
            secrets=True,
        ),
        templates=declared,
    )
    session = FakeSession([0, 0])

    result = execute_plan(
        ExecutionPlan("c", "configure", (configure, start)),
        FakeTransport({"a": session}),
        bindings=ProjectBindings(
            file_secrets={"TLS_KEY": key},
            config_secrets={"DB_PASSWORD": "secret-value", "UNUSED": "not-sent"},
        ),
    )

    assert result.succeeded
    template_uploads = {
        name: value
        for name, value in session.uploaded.items()
        if "/template-" in name
    }
    assert len(template_uploads) == 1
    remote_template, uploaded_content = next(iter(template_uploads.items()))
    assert uploaded_content == b"password=$DB_PASSWORD"
    contexts = [
        json.loads(value)
        for name, value in session.uploaded.items()
        if "/context-" in name
    ]
    assert contexts[0]["metadata"]["templates"] == {
        "templates/app.conf.tpl": remote_template
    }
    assert contexts[0]["config_secrets"] == {"DB_PASSWORD": "secret-value"}
    assert "templates" not in contexts[1]["metadata"]
    assert contexts[1]["config_secrets"] == {}
