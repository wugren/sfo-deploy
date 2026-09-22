import { assert, assertStringIncludes } from "../_support/assert.ts";

const read = (path: string) => Deno.readTextFile(path);
const [readme, guide, exampleReadme, jxServer, jxWeb, nginxConfig, release, templateApp] =
  await Promise
    .all([
      read("README.md"),
      read("docs/guides/sfo-deploy-cluster-configuration.md"),
      read("examples/eleph-server-multipass/README.md"),
      read("examples/eleph-server-multipass/cluster-template/apps/jx-server/app.yaml"),
      read("examples/eleph-server-multipass/cluster-template/apps/jx-web/app.yaml"),
      read("examples/eleph-server-multipass/cluster-template/apps/jx-web/templates/jx-web.conf"),
      read("src/remote_runtime/versioned_release.ts"),
      read("skills/sfo-deploy-cluster/assets/app-versioned/app.yaml"),
    ]);

for (const format of ["YAML", "JSON", "TOML", "INI", "NGINX"]) {
  assertStringIncludes(readme.toLowerCase(), format.toLowerCase());
  assertStringIncludes(guide.toLowerCase(), format.toLowerCase());
}
for (const term of ["systemd", "tar.gz", "秘密"]) {
  assertStringIncludes(readme.toLowerCase(), term.toLowerCase());
  assertStringIncludes(guide.toLowerCase(), term.toLowerCase());
}
for (const term of ["${CURRENT_VERSION_DIRECTORY}", "${LATEST_DIRECTORY}"]) {
  assertStringIncludes(readme, term);
  assertStringIncludes(guide, term);
}
assertStringIncludes(guide, "${DB_PASSWORD}");
assertStringIncludes(exampleReadme, "managed schema 1");
assertStringIncludes(jxWeb, "depends_on: [nginx]");
assertStringIncludes(jxWeb, "target: /etc/nginx/conf.d/jx-web.conf");
assertStringIncludes(jxWeb, "format: nginx");
assertStringIncludes(jxWeb, "on_change: reload");
assertStringIncludes(jxWeb, "kind: file");
assertStringIncludes(jxWeb, "kind: service");
assertStringIncludes(jxWeb, "name: nginx.service");
assertStringIncludes(jxWeb, "on_deploy: none");
assertStringIncludes(jxWeb, 'mode: "0644"');
assert(!jxWeb.includes("run_as:"));
assert(!jxWeb.includes("access_group:"));
assert(!jxWeb.includes("enabled: true"));
assertStringIncludes(nginxConfig, "listen       80;");
assertStringIncludes(nginxConfig, "server_name  localhost;");
assertStringIncludes(nginxConfig, "root   /home/projects/ui/latest;");
assertStringIncludes(nginxConfig, "location /prod-api/");
assertStringIncludes(nginxConfig, "proxy_pass http://localhost:8080/;");
assertStringIncludes(jxServer, "schema_version: 1");
assert(!jxServer.includes("run_as:"));
assertStringIncludes(jxServer, "kind: service");
assertStringIncludes(jxServer, "kind: versioned");
assertStringIncludes(jxServer, "name: jx-server.service");
assertStringIncludes(jxServer, "working_directory: latest");
assertStringIncludes(jxServer, "command: /usr/bin/java");
assertStringIncludes(jxServer, "- -jar");
assertStringIncludes(jxServer, "- base-entry.jar");
assertStringIncludes(jxServer, "- --spring.profiles.active=local");
assertStringIncludes(jxServer, "- -Dloader.path=resources,lib");
assertStringIncludes(jxServer, "on_deploy: restart");
assertStringIncludes(jxServer, "daemon_reload: true");
assert(!jxServer.includes("hooks:"));
assert(!jxServer.includes("scripts:"));
assertStringIncludes(templateApp, "restart_policy: on-failure");
assertStringIncludes(templateApp, "restart_sec: 5");
assertStringIncludes(templateApp, "start_limit_interval_sec: 30");
assertStringIncludes(templateApp, "start_limit_burst: 5");
assertStringIncludes(jxWeb, "schema_version: 1");
assertStringIncludes(jxWeb, "kind: versioned");
assertStringIncludes(jxWeb, 'mode: "0644"');
assert(!jxWeb.includes("run_as:"));
assert(!jxWeb.includes("access_group:"));
assert(!jxServer.includes("run_as:"));
assertStringIncludes(release, 'packageKind !== "validated-directory"');
assertStringIncludes(release, "原子切换 latest");
