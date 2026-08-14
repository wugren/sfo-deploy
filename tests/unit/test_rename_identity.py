from __future__ import annotations

import http.server
import threading
import tomllib
from pathlib import Path

from sfo_deploy.cli import _parser
from sfo_deploy.downloads import DownloadRequest, HttpDownloadProvider
from sfo_deploy.remote_runtime import REMOTE_RUNTIME_SOURCE, write_remote_runtime


class _IdentityHandler(http.server.BaseHTTPRequestHandler):
    user_agent: str | None = None

    def do_GET(self) -> None:  # noqa: N802
        type(self).user_agent = self.headers.get("User-Agent")
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        pass


def test_distribution_package_and_cli_metadata_use_sfo_identity() -> None:
    project = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    assert project["project"]["name"] == "sfo-deploy"
    assert project["project"]["scripts"] == {"sfo-deploy": "sfo_deploy.cli:main"}
    assert project["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"] == [
        "src/sfo_deploy"
    ]
    assert _parser(generic=True).prog == "sfo-deploy"


def test_remote_runtime_writer_and_http_identity_use_sfo_name(tmp_path: Path) -> None:
    target = write_remote_runtime(tmp_path / "sfo_deploy.py")
    assert target.name == "sfo_deploy.py"
    assert target.read_text(encoding="utf-8") == REMOTE_RUNTIME_SOURCE
    assert "sfo-deploy 远端脚本运行时" in REMOTE_RUNTIME_SOURCE

    _IdentityHandler.user_agent = None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _IdentityHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        request = DownloadRequest(
            source={"url": f"http://127.0.0.1:{server.server_port}/package"},
            hash_algorithm="sha256",
            expected_hash=(
                "e3b0c44298fc1c149afbf4c8996fb924"
                "27ae41e4649b934ca495991b7852b855"
            ),
        )
        with HttpDownloadProvider().fetch(request, tmp_path / "package.bin"):
            pass
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    assert _IdentityHandler.user_agent == "sfo-deploy/0.1"
