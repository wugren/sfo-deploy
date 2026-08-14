"""sfo-deploy 严格 known-host 的 Paramiko SSH 传输与远端文件操作。"""

from __future__ import annotations

import re
import secrets as random_secrets
import shlex
import socket
import stat
import time
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, Protocol, Sequence, runtime_checkable

import paramiko

from .errors import PreflightError, TransportError
from .models import ResolvedMachine
from .results import CommandResult
from .secrets import FileSecretDeployment

DEFAULT_CONNECT_TIMEOUT = 10.0
DEFAULT_COMMAND_TIMEOUT = 300.0
_ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")
_WORKSPACE_PREFIX = "/tmp/sfo-deploy-"


@runtime_checkable
class RemoteSession(Protocol):
    def create_workspace(self) -> PurePosixPath: ...

    def upload_file(self, source: Path, destination: PurePosixPath, *, mode: int = 0o600) -> None: ...

    def deploy_file_secret(
        self,
        deployment: FileSecretDeployment,
        *,
        workspace: PurePosixPath,
    ) -> None: ...

    def preflight_python(self, interpreter: str) -> CommandResult: ...

    def preflight_privilege(self) -> None: ...

    def execute_python(
        self,
        interpreter: str,
        script: PurePosixPath,
        *,
        context_path: PurePosixPath | None = None,
        privileged: bool = False,
    ) -> CommandResult: ...

    def remove_file(self, path: PurePosixPath) -> None: ...

    def cleanup_workspace(self, path: PurePosixPath) -> None: ...

    def close(self) -> None: ...


@runtime_checkable
class SSHTransport(Protocol):
    def connect(self, target: ResolvedMachine) -> RemoteSession: ...


class ParamikoTransport:
    """只允许 SSH agent 或机器显式私钥认证的 Paramiko 传输。"""

    def __init__(
        self,
        *,
        known_hosts: Path | None = None,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
        command_timeout: float = DEFAULT_COMMAND_TIMEOUT,
        client_factory: Any = paramiko.SSHClient,
    ) -> None:
        if connect_timeout <= 0 or command_timeout <= 0:
            raise ValueError("SSH 超时必须是正数")
        self.known_hosts = known_hosts
        self.connect_timeout = float(connect_timeout)
        self.command_timeout = float(command_timeout)
        self._client_factory = client_factory

    def connect(self, target: ResolvedMachine) -> ParamikoRemoteSession:
        client = self._client_factory()
        try:
            client.load_system_host_keys()
            if self.known_hosts is not None:
                known_hosts = self.known_hosts.expanduser().resolve(strict=True)
                if not known_hosts.is_file():
                    raise PreflightError(f"known-hosts 不是普通文件: {known_hosts}")
                client.load_host_keys(str(known_hosts))
            client.set_missing_host_key_policy(paramiko.RejectPolicy())
            key = target.machine.ssh_private_key
            client.connect(
                hostname=target.address,
                port=target.machine.ssh_port,
                username=target.machine.ssh_user,
                key_filename=str(key) if key is not None else None,
                allow_agent=key is None,
                look_for_keys=False,
                timeout=self.connect_timeout,
                banner_timeout=self.connect_timeout,
                auth_timeout=self.connect_timeout,
            )
            sftp = client.open_sftp()
            return ParamikoRemoteSession(
                client,
                sftp,
                command_timeout=self.command_timeout,
            )
        except PreflightError:
            client.close()
            raise
        except (OSError, paramiko.SSHException, socket.timeout) as error:
            client.close()
            raise TransportError(
                f"SSH 连接失败 {target.machine.name}@{target.address}: {error}"
            ) from error


class ParamikoRemoteSession:
    def __init__(self, client: Any, sftp: Any, *, command_timeout: float) -> None:
        self._client = client
        self._sftp = sftp
        self._command_timeout = command_timeout
        self._closed = False
        self._workspaces: set[PurePosixPath] = set()
        self._privilege_prefix: tuple[str, ...] | None = None

    def run_argv(
        self,
        argv: Sequence[str],
        *,
        environment: Mapping[str, str] | None = None,
        privileged: bool = False,
    ) -> CommandResult:
        self._ensure_open()
        arguments = _validate_argv(argv)
        command: list[str] = []
        if privileged:
            self.preflight_privilege()
            command.extend(self._privilege_prefix or ())
        if environment:
            command.append("env")
            for name, value in sorted(environment.items()):
                if not _ENV_NAME.fullmatch(name) or not isinstance(value, str) or "\x00" in value:
                    raise TransportError(f"远端命令环境变量不合法: {name!r}")
                command.append(f"{name}={value}")
        command.extend(arguments)
        rendered = "exec " + " ".join(shlex.quote(argument) for argument in command)
        channel: Any = None
        try:
            stdin, stdout, _stderr = self._client.exec_command(
                rendered,
                timeout=self._command_timeout,
                get_pty=False,
            )
            stdin.close()
            channel = stdout.channel
            channel.settimeout(self._command_timeout)
            return _collect_channel(channel, self._command_timeout)
        except (OSError, paramiko.SSHException, socket.timeout) as error:
            raise TransportError(f"远端命令执行失败或超时: {error}") from error
        finally:
            if channel is not None:
                channel.close()

    def create_workspace(self) -> PurePosixPath:
        self._ensure_open()
        for _attempt in range(8):
            workspace = PurePosixPath(
                f"{_WORKSPACE_PREFIX}{random_secrets.token_hex(12)}"
            )
            try:
                self._sftp.mkdir(str(workspace), mode=0o700)
                self._sftp.chmod(str(workspace), 0o700)
                self._workspaces.add(workspace)
                return workspace
            except OSError:
                continue
        raise TransportError("无法创建唯一的远端临时工作目录")

    def upload_file(
        self,
        source: Path,
        destination: PurePosixPath,
        *,
        mode: int = 0o600,
    ) -> None:
        self._ensure_open()
        source = Path(source)
        if not source.is_file():
            raise TransportError(f"上传来源不是普通文件: {source}")
        remote = _safe_remote_path(destination)
        try:
            self._sftp.put(str(source), str(remote), confirm=True)
            self._sftp.chmod(str(remote), mode)
        except OSError as error:
            raise TransportError(f"上传文件失败 {source} -> {remote}: {error}") from error

    def deploy_file_secret(
        self,
        deployment: FileSecretDeployment,
        *,
        workspace: PurePosixPath,
    ) -> None:
        """先暂存到会话工作区，再以非交互提权命令原子安装。"""

        self._ensure_open()
        workspace = _safe_remote_path(workspace)
        if workspace not in self._workspaces:
            raise TransportError(f"文件私钥必须暂存到当前会话工作目录: {workspace}")
        destination = _safe_remote_path(deployment.destination)
        staged = workspace / f"secret-{random_secrets.token_hex(8)}"
        temporary = destination.parent / f".{destination.name}.deployment-{random_secrets.token_hex(8)}"
        privilege_ready = False
        try:
            self.upload_file(deployment.source, staged, mode=0o600)
            self.preflight_privilege()
            privilege_ready = True
            install_argv = ["install", "-m", f"{deployment.mode:04o}"]
            if deployment.owner is not None:
                install_argv.extend(("-o", deployment.owner))
            if deployment.group is not None:
                install_argv.extend(("-g", deployment.group))
            install_argv.extend(("--", str(staged), str(temporary)))
            self._require_success(install_argv, "创建文件私钥目标临时文件")
            if deployment.overwrite:
                self._require_success(
                    ("mv", "-f", "-T", "--", str(temporary), str(destination)),
                    "原子替换文件私钥",
                )
            else:
                self._require_success(
                    ("mv", "-n", "-T", "--", str(temporary), str(destination)),
                    "原子安装文件私钥",
                )
                collision = self.run_argv(("test", "!", "-e", str(temporary)), privileged=True)
                if collision.exit_code != 0:
                    raise TransportError(f"文件私钥目标已存在且禁止覆盖: {destination}")
        finally:
            try:
                self._sftp.remove(str(staged))
            except OSError:
                pass
            if privilege_ready:
                try:
                    self.run_argv(("rm", "-f", "--", str(temporary)), privileged=True)
                except Exception:
                    pass

    def _require_success(self, argv: Sequence[str], operation: str) -> None:
        result = self.run_argv(argv, privileged=True)
        if result.exit_code != 0:
            detail = result.stderr.strip() or result.stdout.strip()
            raise TransportError(f"{operation}失败: {detail or f'exit={result.exit_code}'}")

    def preflight_python(self, interpreter: str) -> CommandResult:
        result = self.run_argv((interpreter, "--version"))
        version_text = f"{result.stdout}\n{result.stderr}".strip()
        if result.exit_code != 0 or not version_text.startswith("Python 3."):
            raise PreflightError(
                f"远端 Python 3 解释器不可用 {interpreter!r}: {version_text}"
            )
        return result

    def preflight_privilege(self) -> None:
        if self._privilege_prefix is not None:
            return
        identity = self.run_argv(("id", "-u"))
        if identity.exit_code == 0 and identity.stdout.strip() == "0":
            self._privilege_prefix = ()
            return
        sudo = self.run_argv(("sudo", "-n", "--", "true"))
        if sudo.exit_code != 0:
            raise PreflightError("远端身份既不是 root，也不能使用非交互 sudo")
        self._privilege_prefix = ("sudo", "-n", "--")

    def execute_python(
        self,
        interpreter: str,
        script: PurePosixPath,
        *,
        context_path: PurePosixPath | None = None,
        privileged: bool = False,
    ) -> CommandResult:
        environment = (
            {"DEPLOYMENT_CONTEXT_PATH": str(_safe_remote_path(context_path))}
            if context_path is not None
            else None
        )
        return self.run_argv(
            (interpreter, str(_safe_remote_path(script))),
            environment=environment,
            privileged=privileged,
        )

    def remove_file(self, path: PurePosixPath) -> None:
        self._ensure_open()
        remote = _safe_remote_path(path)
        try:
            self._sftp.remove(str(remote))
        except FileNotFoundError:
            return
        except OSError as error:
            if getattr(error, "errno", None) == 2:
                return
            raise TransportError(f"远端文件清理失败 {remote}: {error}") from error

    def cleanup_workspace(self, path: PurePosixPath) -> None:
        self._ensure_open()
        remote = _safe_remote_path(path)
        if remote not in self._workspaces or not str(remote).startswith(_WORKSPACE_PREFIX):
            raise TransportError(f"拒绝清理非会话工作目录: {remote}")
        try:
            self._remove_tree(remote)
            self._workspaces.remove(remote)
        except OSError as error:
            raise TransportError(f"远端工作目录清理失败 {remote}: {error}") from error

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._sftp.close()
        finally:
            self._client.close()

    def _exists(self, path: PurePosixPath) -> bool:
        try:
            self._sftp.lstat(str(path))
            return True
        except FileNotFoundError:
            return False
        except OSError as error:
            # Paramiko 可能把 ENOENT 统一包装为 IOError；仅 errno=2 表示不存在。
            if getattr(error, "errno", None) == 2:
                return False
            raise

    def _remove_tree(self, path: PurePosixPath) -> None:
        attributes = self._sftp.lstat(str(path))
        if stat.S_ISDIR(attributes.st_mode) and not stat.S_ISLNK(attributes.st_mode):
            for child in self._sftp.listdir_attr(str(path)):
                self._remove_tree(path / child.filename)
            self._sftp.rmdir(str(path))
        else:
            self._sftp.remove(str(path))

    def _ensure_open(self) -> None:
        if self._closed:
            raise TransportError("SSH 会话已经关闭")


def _validate_argv(argv: Sequence[str]) -> tuple[str, ...]:
    if not argv:
        raise TransportError("远端命令不能为空")
    result: list[str] = []
    for value in argv:
        if not isinstance(value, str) or not value or "\x00" in value:
            raise TransportError(f"远端命令参数不合法: {value!r}")
        result.append(value)
    return tuple(result)


def _safe_remote_path(path: PurePosixPath | None) -> PurePosixPath:
    if path is None:
        raise TransportError("远端路径不能为空")
    value = str(path)
    normalized = PurePosixPath(value)
    if (
        not normalized.is_absolute()
        or normalized == PurePosixPath("/")
        or ".." in normalized.parts
        or "\x00" in value
        or "\\" in value
    ):
        raise TransportError(f"远端路径不安全: {value!r}")
    return normalized


def _collect_channel(channel: Any, timeout: float) -> CommandResult:
    stdout = bytearray()
    stderr = bytearray()
    deadline = time.monotonic() + timeout
    while True:
        progressed = False
        while channel.recv_ready():
            stdout.extend(channel.recv(65536))
            progressed = True
        while channel.recv_stderr_ready():
            stderr.extend(channel.recv_stderr(65536))
            progressed = True
        if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
            break
        if time.monotonic() >= deadline:
            raise socket.timeout("远端命令读取超时")
        if not progressed:
            time.sleep(0.01)
    return CommandResult(
        exit_code=channel.recv_exit_status(),
        stdout=stdout.decode("utf-8", errors="replace"),
        stderr=stderr.decode("utf-8", errors="replace"),
    )


__all__ = [
    "DEFAULT_COMMAND_TIMEOUT",
    "DEFAULT_CONNECT_TIMEOUT",
    "ParamikoRemoteSession",
    "ParamikoTransport",
    "RemoteSession",
    "SSHTransport",
]
