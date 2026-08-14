from __future__ import annotations

from pathlib import Path, PurePosixPath

import pytest

from sfo_deploy import TransportError
from sfo_deploy.results import CommandResult
from sfo_deploy.secrets import FileSecretDeployment
from sfo_deploy.transport import ParamikoRemoteSession


class _FakeSFTP:
    def __init__(self, events: list[tuple[object, ...]]) -> None:
        self.events = events

    def mkdir(self, path: str, mode: int) -> None:
        self.events.append(("mkdir", path, mode))

    def chmod(self, path: str, mode: int) -> None:
        self.events.append(("chmod", path, mode))

    def put(self, source: str, destination: str, *, confirm: bool) -> None:
        self.events.append(("put", source, destination, confirm))

    def remove(self, path: str) -> None:
        self.events.append(("sftp-remove", path))

    def close(self) -> None:
        self.events.append(("sftp-close",))


class _FakeClient:
    def close(self) -> None:
        pass


class _RecordingParamikoSession(ParamikoRemoteSession):
    def __init__(self, *, collision: bool = False) -> None:
        self.events: list[tuple[object, ...]] = []
        self.collision = collision
        super().__init__(_FakeClient(), _FakeSFTP(self.events), command_timeout=1)

    def run_argv(self, argv, *, environment=None, privileged=False) -> CommandResult:
        arguments = tuple(argv)
        self.events.append(("run", arguments, privileged, environment))
        if arguments == ("id", "-u"):
            return CommandResult(0, stdout="1000\n")
        if len(arguments) == 4 and arguments[:3] == ("test", "!", "-e"):
            return CommandResult(1 if self.collision else 0)
        return CommandResult(0)


def _deployment(source: Path, *, overwrite: bool) -> FileSecretDeployment:
    return FileSecretDeployment(
        name="TLS_KEY",
        source=source,
        destination=PurePosixPath("/etc/example/server.key"),
        mode=0o600,
        owner="deploy",
        group="deploy",
        overwrite=overwrite,
    )


def _run_events(session: _RecordingParamikoSession):
    return [event for event in session.events if event[0] == "run"]


def test_file_secret_stages_then_privileged_installs_atomically_and_cleans(
    tmp_path: Path,
) -> None:
    source = tmp_path / "server.key"
    source.write_text("private-key", encoding="utf-8")
    session = _RecordingParamikoSession()
    workspace = session.create_workspace()

    session.deploy_file_secret(_deployment(source, overwrite=True), workspace=workspace)

    put = next(event for event in session.events if event[0] == "put")
    staged = PurePosixPath(str(put[2]))
    assert staged.parent == workspace
    assert not str(put[2]).startswith("/etc/")
    assert ("chmod", str(staged), 0o600) in session.events

    runs = _run_events(session)
    id_index = runs.index(("run", ("id", "-u"), False, None))
    sudo_index = runs.index(("run", ("sudo", "-n", "--", "true"), False, None))
    install_index = next(index for index, event in enumerate(runs) if event[1][0] == "install")
    assert id_index < sudo_index < install_index
    install = runs[install_index]
    assert install[2] is True
    assert install[1][:6] == ("install", "-m", "0600", "-o", "deploy", "-g")
    assert "--" in install[1]
    temporary = PurePosixPath(install[1][-1])
    assert temporary.parent == PurePosixPath("/etc/example")
    assert temporary.name.startswith(".server.key.deployment-")

    move = next(event for event in runs if event[1][:3] == ("mv", "-f", "-T"))
    assert move[2] is True
    assert move[1][-2:] == (str(temporary), "/etc/example/server.key")
    assert ("sftp-remove", str(staged)) in session.events
    assert any(event[1][:3] == ("rm", "-f", "--") and event[1][-1] == str(temporary) for event in runs)


def test_file_secret_no_overwrite_collision_fails_and_cleans_both_temporaries(
    tmp_path: Path,
) -> None:
    source = tmp_path / "server.key"
    source.write_text("private-key", encoding="utf-8")
    session = _RecordingParamikoSession(collision=True)
    workspace = session.create_workspace()

    with pytest.raises(TransportError):
        session.deploy_file_secret(_deployment(source, overwrite=False), workspace=workspace)

    put = next(event for event in session.events if event[0] == "put")
    staged = str(put[2])
    runs = _run_events(session)
    install = next(event for event in runs if event[1][0] == "install")
    temporary = install[1][-1]
    assert any(event[1][:3] == ("mv", "-n", "-T") for event in runs)
    assert any(event[1][:3] == ("test", "!", "-e") for event in runs)
    assert ("sftp-remove", staged) in session.events
    assert any(event[1][:3] == ("rm", "-f", "--") and event[1][-1] == temporary for event in runs)
    assert all(not str(event[2]).startswith("/etc/") for event in session.events if event[0] == "put")
