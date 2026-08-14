from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
import tomllib
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CHANGE_ID = "CHG-rename-sfo-deploy"
OLD_DISTRIBUTION = "deployment-framework"
OLD_PACKAGE = "deployment_framework"
OLD_CLI = "deploy-framework"
OLD_TASK_SCOPE = "deployment-framework/005-rename-to-sfo-deploy"
NEW_DISTRIBUTION = "sfo-deploy"
NEW_PACKAGE = "sfo_deploy"
NEW_CLI = "sfo-deploy"
NEW_TASK_SCOPE = "sfo-deploy/005-rename-to-sfo-deploy"


def run(
    command: list[str],
    *,
    cwd: Path = ROOT,
    env: dict[str, str] | None = None,
    expect_success: bool = True,
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )
    if expect_success and completed.returncode != 0:
        raise AssertionError(
            f"command failed ({completed.returncode}): {command!r}\n"
            f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
        )
    return completed


def build_wheel(output: Path) -> Path:
    environment = dict(os.environ)
    environment["UV_CACHE_DIR"] = str(ROOT / ".harness" / "uv-cache")
    run(["uv", "build", "--wheel", "--out-dir", str(output)], env=environment)
    wheels = list(output.glob("*.whl"))
    if len(wheels) != 1:
        raise AssertionError(f"expected exactly one wheel, found: {wheels}")
    return wheels[0]


def wheel_members(wheel: Path) -> tuple[set[str], str, str]:
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
        metadata_path = next(name for name in names if name.endswith(".dist-info/METADATA"))
        entry_points_path = next(
            name for name in names if name.endswith(".dist-info/entry_points.txt")
        )
        metadata = archive.read(metadata_path).decode("utf-8")
        entry_points = archive.read(entry_points_path).decode("utf-8")
    return names, metadata, entry_points


def external_positive() -> None:
    with tempfile.TemporaryDirectory(prefix="sfo-deploy-positive-") as raw_temp:
        temporary = Path(raw_temp)
        wheel = build_wheel(temporary)
        names, metadata, entry_points = wheel_members(wheel)
        assert f"Name: {NEW_DISTRIBUTION}\n" in metadata
        assert f"{NEW_PACKAGE}/__init__.py" in names
        assert f"{NEW_CLI} = {NEW_PACKAGE}.cli:main" in entry_points

        consumer = (
            "import pathlib,sys;"
            f"sys.path.insert(0, {str(wheel)!r});"
            f"import {NEW_PACKAGE};"
            f"assert pathlib.Path({NEW_PACKAGE}.__file__).as_posix().startswith({wheel.as_posix()!r})"
        )
        run([sys.executable, "-I", "-c", consumer], cwd=temporary)


def external_negative() -> None:
    with tempfile.TemporaryDirectory(prefix="sfo-deploy-negative-") as raw_temp:
        temporary = Path(raw_temp)
        wheel = build_wheel(temporary)
        names, metadata, entry_points = wheel_members(wheel)
        assert f"Name: {OLD_DISTRIBUTION}\n" not in metadata
        assert not any(name.startswith(f"{OLD_PACKAGE}/") for name in names)
        assert f"{OLD_CLI} =" not in entry_points

        consumer = (
            "import importlib,sys;"
            f"sys.path.insert(0, {str(wheel)!r});"
            f"importlib.import_module({OLD_PACKAGE!r})"
        )
        rejected_import = run(
            # -S is intentional here: the current editable development
            # environment adds the repository-wide src directory with a .pth
            # file, where ignored cache directories can form namespace
            # packages. An external wheel consumer must see only stdlib plus
            # the built artifact for this removed-path assertion.
            [sys.executable, "-I", "-S", "-c", consumer],
            cwd=temporary,
            expect_success=False,
        )
        assert rejected_import.returncode != 0
        assert "ModuleNotFoundError" in rejected_import.stderr
        assert OLD_PACKAGE in rejected_import.stderr

    rejected_route = run(
        [
            sys.executable,
            "harness/scripts/test-run.py",
            OLD_TASK_SCOPE,
            "all",
            "--dry-run",
        ],
        expect_success=False,
    )
    assert rejected_route.returncode != 0
    assert "unknown module or task scope" in rejected_route.stderr


def repository_compile_closure() -> None:
    compile_targets = [
        "src",
        "tests",
        "examples/eleph-server-multipass/src",
        "examples/eleph-server-multipass/cluster-template",
        "examples/eleph-server-multipass/tests",
    ]
    run([sys.executable, "-m", "compileall", "-q", *compile_targets])
    run([sys.executable, "-m", "pytest", "--collect-only", "-q", "tests"])
    run(
        [
            sys.executable,
            "-m",
            "pytest",
            "--collect-only",
            "-q",
            "examples/eleph-server-multipass/tests",
        ]
    )

    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert project["project"]["name"] == NEW_DISTRIBUTION
    assert project["project"]["scripts"] == {NEW_CLI: f"{NEW_PACKAGE}.cli:main"}
    assert project["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"] == [
        f"src/{NEW_PACKAGE}"
    ]
    lock = (ROOT / "uv.lock").read_text(encoding="utf-8")
    assert re.search(r'(?m)^name = "sfo-deploy"$', lock)

    listed = run(
        [sys.executable, "harness/scripts/test-run.py", "ignored", "all", "--list"]
    )
    assert NEW_TASK_SCOPE in listed.stdout.splitlines()


def documentation_examples() -> None:
    root_readme = (ROOT / "README.md").read_text(encoding="utf-8")
    example_readme = (
        ROOT / "examples" / "eleph-server-multipass" / "README.md"
    ).read_text(encoding="utf-8")
    for index, source in enumerate(
        re.findall(r"```python\s*\n(.*?)```", root_readme, flags=re.DOTALL), start=1
    ):
        compile(source, f"README.md python block {index}", "exec")
    assert f"# {NEW_DISTRIBUTION}" in root_readme
    assert f"from {NEW_PACKAGE} import create_cli" in root_readme
    assert f"from {NEW_PACKAGE} import DeploymentContext" in root_readme
    assert f"{NEW_CLI} validate" in root_readme
    assert f"`{NEW_DISTRIBUTION}`" in example_readme


MODES = {
    "external-positive": external_positive,
    "external-negative": external_negative,
    "repository-compile-closure": repository_compile_closure,
    "documentation-examples": documentation_examples,
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=sorted(MODES))
    args = parser.parse_args()
    MODES[args.mode]()
    print(f"{CHANGE_ID}: {args.mode} passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
