from __future__ import annotations

from pathlib import Path

import pytest

from sfo_deploy import ConfigurationError, PlanningError, build_plan, load_cluster, resolve_machine


def test_loads_v1_and_resolves_region_addresses(cluster_root: Path) -> None:
    cluster = load_cluster(cluster_root / "production")
    assert tuple(cluster.machines) == ("east-host", "west-host")
    assert resolve_machine(cluster, "east-host").address == "10.0.0.1"
    assert resolve_machine(cluster, "west-host").address == "203.0.113.2"
    assert resolve_machine(cluster, "west-host", address_kind="private").address == "10.1.0.1"


@pytest.mark.parametrize(
    "filename,replacement",
    [
        ("cluster.yaml", ("schema_version: 1", "schema_version: 2")),
        ("cluster.yaml", ("executor_region: east", "executor_region: east\nunknown: true")),
        ("machines.yaml", ("schema_version: 1", "schema_version: 1\nschema_version: 1")),
    ],
)
def test_rejects_version_unknown_and_duplicate_keys(
    cluster_root: Path, filename: str, replacement: tuple[str, str]
) -> None:
    path = cluster_root / "production" / filename
    path.write_text(path.read_text(encoding="utf-8").replace(*replacement), encoding="utf-8")
    with pytest.raises(ConfigurationError):
        load_cluster(cluster_root / "production")


def test_rejects_non_python_and_escaping_scripts(cluster_root: Path) -> None:
    app_yaml = cluster_root / "production" / "apps" / "backend" / "app.yaml"
    original = app_yaml.read_text(encoding="utf-8")
    app_yaml.write_text(original.replace("scripts/deploy.py", "scripts/deploy.sh"), encoding="utf-8")
    (app_yaml.parent / "scripts" / "deploy.sh").write_text("echo no", encoding="utf-8")
    with pytest.raises(ConfigurationError):
        load_cluster(cluster_root / "production")
    app_yaml.write_text(original.replace("scripts/deploy.py", "../escape.py"), encoding="utf-8")
    with pytest.raises(ConfigurationError):
        load_cluster(cluster_root / "production")


def test_stable_topology_keeps_environment_before_apps(cluster_root: Path) -> None:
    plan = build_plan(load_cluster(cluster_root / "production"), "deploy", with_dependencies=True)
    ids = [step.id for step in plan.steps]
    for machine in ("east-host", "west-host"):
        assert ids.index(f"env:{machine}/db:configure") < ids.index(f"app:{machine}/backend:configure")
    assert ids == sorted(ids, key=lambda item: ids.index(item))


def test_templates_load_for_environment_and_app_but_only_configure_steps_carry_them(
    cluster_root: Path,
) -> None:
    cluster = load_cluster(cluster_root / "production")
    assert [item.relative_path for item in cluster.environments["database"].scripts.templates] == [
        "templates/database.conf.tpl"
    ]
    assert [item.relative_path for item in cluster.apps["backend"].scripts.templates] == [
        "templates/app.conf.tpl"
    ]

    plan = build_plan(cluster, "deploy", with_dependencies=True)
    for step in plan.steps:
        if step.action == "configure":
            expected = (
                "templates/database.conf.tpl"
                if step.kind == "environment"
                else "templates/app.conf.tpl"
            )
            assert [item.relative_path for item in step.templates] == [expected]
        else:
            assert step.templates == ()


@pytest.mark.parametrize(
    "declaration",
    [
        "[/absolute.tpl]",
        "['templates\\\\app.conf.tpl']",
        "[../outside.tpl]",
        "[templates//app.conf.tpl]",
        "[templates]",
        "[templates/missing.tpl]",
        "[templates/app.conf.tpl, templates/app.conf.tpl]",
    ],
    ids=["absolute", "backslash", "parent", "non-canonical", "directory", "missing", "duplicate"],
)
def test_template_paths_fail_closed(cluster_root: Path, declaration: str) -> None:
    app_yaml = cluster_root / "production" / "apps" / "backend" / "app.yaml"
    app_yaml.write_text(
        app_yaml.read_text(encoding="utf-8").replace(
            "templates: [templates/app.conf.tpl]",
            f"templates: {declaration}",
        ),
        encoding="utf-8",
    )
    with pytest.raises(ConfigurationError):
        load_cluster(cluster_root / "production")


def test_cycle_and_missing_route_fail_before_execution(cluster_root: Path) -> None:
    machines = cluster_root / "production" / "machines.yaml"
    text = machines.read_text(encoding="utf-8")
    machines.write_text(text.replace("parameters: {port: 5432}", "parameters: {port: 5432}\n        depends_on: [db]"), encoding="utf-8")
    cluster = load_cluster(cluster_root / "production")
    with pytest.raises(PlanningError):
        build_plan(cluster, "deploy", with_dependencies=True)
    machines.write_text(text.replace("    public_ip: 203.0.113.2\n", ""), encoding="utf-8")
    cluster = load_cluster(cluster_root / "production")
    with pytest.raises(PlanningError):
        build_plan(cluster, "deploy", machines=["west-host"], apps=["backend"], with_dependencies=True)


def test_targeted_app_without_dependencies_still_plans_dependency_checks(cluster_root: Path) -> None:
    plan = build_plan(
        load_cluster(cluster_root / "production"),
        "deploy",
        machines=["east-host"],
        apps=["backend"],
        with_dependencies=False,
    )
    assert [step.id for step in plan.steps][:1] == ["env:east-host/db:check"]
    assert "env:east-host/db:install" not in {step.id for step in plan.steps}
