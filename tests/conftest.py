from __future__ import annotations

import hashlib
from pathlib import Path

import pytest


PACKAGE_BYTES = b"sfo-deploy-test-package"
PACKAGE_HASH = hashlib.sha256(PACKAGE_BYTES).hexdigest()


def write_cluster(root: Path, *, name: str = "production") -> Path:
    cluster = root / name
    (cluster / "environments" / "database" / "scripts").mkdir(parents=True)
    (cluster / "environments" / "database" / "templates").mkdir(parents=True)
    (cluster / "apps" / "backend" / "scripts").mkdir(parents=True)
    (cluster / "apps" / "backend" / "templates").mkdir(parents=True)

    (cluster / "cluster.yaml").write_text(
        """schema_version: 1
name: production
executor_region: east
apps:
  backend: [east-host, west-host]
""",
        encoding="utf-8",
    )
    (cluster / "machines.yaml").write_text(
        """schema_version: 1
machines:
  - name: east-host
    domains: [east.example.test]
    private_ip: 10.0.0.1
    public_ip: 203.0.113.1
    region: east
    ssh_user: deploy
    environments:
      - name: db
        definition: database
        version: "15"
        parameters: {port: 5432}
  - name: west-host
    domains: [west.example.test]
    private_ip: 10.1.0.1
    public_ip: 203.0.113.2
    region: west
    ssh_user: deploy
    environments:
      - name: db
        definition: database
        version: "15"
        parameters: {port: 5433}
""",
        encoding="utf-8",
    )
    (cluster / "environments" / "database" / "environment.yaml").write_text(
        f"""schema_version: 1
name: database
defaults: {{data_dir: /srv/db}}
requires_privilege: true
package:
  provider: memory
  source: {{key: database}}
  hash:
    algorithm: sha256
    value: {PACKAGE_HASH}
scripts:
  check: [scripts/check.py]
  install: [scripts/install.py]
  configure: [scripts/configure.py]
  start: [scripts/start.py]
  stop: [scripts/stop.py]
  restart: [scripts/restart.py]
config_secrets: [DB_PASSWORD]
templates: [templates/database.conf.tpl]
file_secrets:
  - name: TLS_KEY
    path: /etc/example/server.key
    mode: "0600"
""",
        encoding="utf-8",
    )
    (cluster / "apps" / "backend" / "app.yaml").write_text(
        f"""schema_version: 1
name: backend
version: "1.2.3"
package:
  provider: memory
  source: {{key: backend}}
  hash:
    algorithm: sha256
    value: {PACKAGE_HASH}
depends_on: [db]
scripts:
  configure: [scripts/configure.py]
  deploy: [scripts/deploy.py]
  start: [scripts/start.py]
  stop: [scripts/stop.py]
  restart: [scripts/restart.py]
config_secrets: [DB_PASSWORD]
templates: [templates/app.conf.tpl]
file_secrets:
  - name: TLS_KEY
    path: /etc/example/server.key
    mode: "0600"
""",
        encoding="utf-8",
    )
    for path in (cluster / "environments" / "database" / "scripts").glob("*.py"):
        path.write_text("raise RuntimeError('fixture placeholder')\n", encoding="utf-8")
    for action in ("check", "install", "configure", "start", "stop", "restart"):
        (cluster / "environments" / "database" / "scripts" / f"{action}.py").write_text(
            "print('ok')\n", encoding="utf-8"
        )
    for action in ("configure", "deploy", "start", "stop", "restart"):
        (cluster / "apps" / "backend" / "scripts" / f"{action}.py").write_text(
            "print('ok')\n", encoding="utf-8"
        )
    (cluster / "environments" / "database" / "templates" / "database.conf.tpl").write_text(
        "password=$DB_PASSWORD\n", encoding="utf-8"
    )
    (cluster / "apps" / "backend" / "templates" / "app.conf.tpl").write_text(
        "password=${DB_PASSWORD} dollar=$$\n", encoding="utf-8"
    )
    return cluster


@pytest.fixture
def cluster_root(tmp_path: Path) -> Path:
    write_cluster(tmp_path)
    return tmp_path
