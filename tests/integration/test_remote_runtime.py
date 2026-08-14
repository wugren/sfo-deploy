from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import replace
from pathlib import Path, PurePosixPath

from sfo_deploy import ProjectBindings, build_plan, load_cluster
from sfo_deploy.execution import execute_plan
from sfo_deploy.models import ExecutionPlan, ResolvedMachine
from sfo_deploy.results import CommandResult

from conftest import write_cluster


class _LocalRemoteSession:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.events: list[tuple[object, ...]] = []
        self.rendered: str | None = None

    def create_workspace(self) -> PurePosixPath:
        self.root.mkdir()
        self.events.append(("workspace", self.root.as_posix()))
        return PurePosixPath(self.root.as_posix())

    def upload_file(
        self, source: Path, destination: PurePosixPath, *, mode: int = 0o600
    ) -> None:
        target = Path(str(destination))
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        target.chmod(mode)
        self.events.append(("upload", source.resolve(), target.resolve(), mode))

    def deploy_file_secret(self, deployment, *, workspace: PurePosixPath) -> None:
        self.events.append(("file-secret", deployment.name, str(workspace)))

    def preflight_python(self, interpreter: str) -> CommandResult:
        self.events.append(("python", interpreter))
        return CommandResult(0, stdout=f"Python {sys.version_info.major}.{sys.version_info.minor}")

    def preflight_privilege(self) -> None:
        self.events.append(("privilege",))

    def execute_python(
        self,
        interpreter: str,
        script: PurePosixPath,
        *,
        context_path: PurePosixPath | None = None,
        privileged: bool = False,
    ) -> CommandResult:
        assert context_path is not None
        environment = {
            key: value
            for key, value in os.environ.items()
            if key not in {"PYTHONPATH", "PYTHONHOME"}
        }
        environment["DEPLOYMENT_CONTEXT_PATH"] = str(context_path)
        completed = subprocess.run(
            [sys.executable, str(script)],
            cwd=self.root,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        rendered = self.root / "rendered.conf"
        if rendered.exists():
            self.rendered = rendered.read_text(encoding="utf-8")
        self.events.append(("execute", Path(str(script)).resolve(), privileged))
        return CommandResult(completed.returncode, completed.stdout, completed.stderr)

    def remove_file(self, path: PurePosixPath) -> None:
        Path(str(path)).unlink(missing_ok=True)
        self.events.append(("remove", Path(str(path)).resolve()))

    def cleanup_workspace(self, path: PurePosixPath) -> None:
        self.events.append(("cleanup", str(path)))

    def close(self) -> None:
        self.events.append(("close",))


class _LocalTransport:
    def __init__(self, session: _LocalRemoteSession) -> None:
        self.session = session

    def connect(self, target: ResolvedMachine) -> _LocalRemoteSession:
        return self.session


def test_loaded_template_is_uploaded_then_rendered_by_remote_shim(tmp_path: Path) -> None:
    config_root = tmp_path / "clusters"
    cluster_dir = write_cluster(config_root)
    configure_script = cluster_dir / "apps" / "backend" / "scripts" / "configure.py"
    configure_script.write_text(
        """from pathlib import Path
import sfo_deploy
from sfo_deploy import DeploymentContext

assert Path(sfo_deploy.__file__).resolve().parent == Path.cwd()
context = DeploymentContext.from_environment()
assert context.config_secret("DB_PASSWORD") == "remote-secret"
template = Path(context.metadata["templates"]["templates/app.conf.tpl"])
assert template.is_file()
context.render_template(template, Path("rendered.conf"))
""",
        encoding="utf-8",
    )
    cluster = load_cluster(cluster_dir)
    complete_plan = build_plan(
        cluster,
        "deploy",
        machines=["east-host"],
        apps=["backend"],
        with_dependencies=False,
    )
    configure = replace(
        next(
            step
            for step in complete_plan.steps
            if step.kind == "app" and step.action == "configure"
        ),
        depends_on=(),
    )
    remote = tmp_path / "clean-remote"
    assert not remote.exists()
    session = _LocalRemoteSession(remote)
    key = tmp_path / "server.key"
    key.write_text("private-key", encoding="utf-8")

    result = execute_plan(
        ExecutionPlan(cluster.name, "configure", (configure,)),
        _LocalTransport(session),
        bindings=ProjectBindings(
            file_secrets={"TLS_KEY": key},
            config_secrets={"DB_PASSWORD": "remote-secret", "UNUSED": "not-sent"},
        ),
    )

    assert result.succeeded, result.steps
    assert session.rendered == "password=remote-secret dollar=$\n"
    uploads = [event for event in session.events if event[0] == "upload"]
    template_source = (cluster_dir / "apps" / "backend" / "templates" / "app.conf.tpl").resolve()
    template_upload = next(event for event in uploads if event[1] == template_source)
    assert Path(str(template_upload[2])).parent == remote.resolve()
    assert any(Path(str(event[2])).name == "sfo_deploy.py" for event in uploads)
    assert uploads.index(template_upload) < next(
        index
        for index, event in enumerate(uploads)
        if Path(str(event[2])).name.startswith("script-")
    )
