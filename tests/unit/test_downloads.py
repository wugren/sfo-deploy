from __future__ import annotations

import hashlib
import http.server
import threading
from pathlib import Path

import pytest

from sfo_deploy import DownloadError
from sfo_deploy.downloads import DownloadProviderRegistry, DownloadRequest, HttpDownloadProvider, VerifiedArtifact


PAYLOAD = b"verified package bytes"


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/package")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(PAYLOAD)))
        self.end_headers()
        self.wfile.write(PAYLOAD)

    def log_message(self, format: str, *args: object) -> None:
        pass


@pytest.fixture
def local_url() -> str:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def request(url: str, digest: str | None = None, **limits: object) -> DownloadRequest:
    return DownloadRequest(
        source={"url": url},
        hash_algorithm="sha256",
        expected_hash=digest or hashlib.sha256(PAYLOAD).hexdigest(),
        **limits,
    )


def test_http_stream_redirect_hash_and_context_cleanup(tmp_path: Path, local_url: str) -> None:
    destination = tmp_path / "package.bin"
    with HttpDownloadProvider().fetch(request(local_url + "/redirect"), destination) as artifact:
        assert artifact.path.read_bytes() == PAYLOAD
        assert artifact.size == len(PAYLOAD)
    assert not destination.exists()


def test_hash_and_capacity_failures_remove_partial_files(tmp_path: Path, local_url: str) -> None:
    destination = tmp_path / "package.bin"
    with pytest.raises(DownloadError):
        HttpDownloadProvider().fetch(request(local_url + "/package", "0" * 64), destination)
    assert list(tmp_path.iterdir()) == []
    with pytest.raises(DownloadError):
        HttpDownloadProvider().fetch(request(local_url + "/package", max_bytes=1), destination)
    assert list(tmp_path.iterdir()) == []


def test_https_scheme_and_custom_provider_are_checked(tmp_path: Path) -> None:
    import sfo_deploy.downloads as downloads

    assert downloads._connection(downloads._parse_http_url("https://example.test/pkg"), 1).__class__.__name__ == "HTTPSConnection"

    class BadProvider:
        def fetch(self, request: DownloadRequest, destination: Path) -> VerifiedArtifact:
            destination.write_bytes(b"tampered")
            return VerifiedArtifact(destination, "sha256", "0" * 64, 8)

    destination = tmp_path / "custom.bin"
    registry = DownloadProviderRegistry({"custom": BadProvider()})
    with pytest.raises(DownloadError):
        registry.fetch("custom", request("http://example.test/package"), destination)
    assert not destination.exists()


@pytest.mark.parametrize(
    "url",
    ["file:///tmp/package", "http://user:pass@example.test/package", "http:///missing-host"],
)
def test_url_boundary_rejections(tmp_path: Path, url: str) -> None:
    with pytest.raises(DownloadError):
        HttpDownloadProvider().fetch(request(url), tmp_path / "package")
