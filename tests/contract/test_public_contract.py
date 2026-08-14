from __future__ import annotations

import subprocess
import sys
import zipfile
import os
from pathlib import Path

import sfo_deploy


def test_public_exports_and_readme_examples() -> None:
    for name in ("create_cli", "run", "RunOptions", "ProjectBindings", "DeploymentContext"):
        assert name in sfo_deploy.__all__
        assert getattr(sfo_deploy, name) is not None
    readme = Path("README.md").read_text(encoding="utf-8")
    assert "from sfo_deploy import create_cli" in readme
    assert "DeploymentContext.from_environment()" in readme
    assert "sfo-deploy validate" in readme


def test_wheel_build_contains_importable_package(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[2]
    environment = dict(os.environ)
    environment["UV_CACHE_DIR"] = str(root / ".harness" / "uv-cache")
    completed = subprocess.run(
        ["uv", "build", "--wheel", "--out-dir", str(tmp_path)],
        cwd=root,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )
    assert completed.returncode == 0, (completed.stdout or "") + (completed.stderr or "")
    wheel = next(tmp_path.glob("*.whl"))
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
    assert "sfo_deploy/__init__.py" in names
    assert any(name.endswith(".dist-info/entry_points.txt") for name in names)


def test_console_module_help_is_callable() -> None:
    completed = subprocess.run(
        [sys.executable, "-m", "sfo_deploy", "--help"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=30,
    )
    assert completed.returncode == 0
    assert "--config-root" in completed.stdout
