import { assert, assertStringIncludes } from "../_support/assert.ts";

const read = (path: string) => Deno.readTextFile(path);
const [readme, guide, exampleReadme, appYaml, jxServer, jxWeb, release] = await Promise
  .all([
    read("README.md"),
    read("docs/guides/sfo-deploy-cluster-configuration.md"),
    read("examples/eleph-server-multipass/README.md"),
    read("examples/eleph-server-multipass/cluster-template/apps/nginx/app.yaml"),
    read("examples/eleph-server-multipass/cluster-template/apps/jx-server/app.yaml"),
    read("examples/eleph-server-multipass/cluster-template/apps/jx-web/app.yaml"),
    read("src/remote_runtime/versioned_release.ts"),
    read("examples/eleph-server-multipass/cluster-template/apps/jx-web/app.yaml"),
  ]);

for (const format of ["YAML", "JSON", "TOML", "INI"]) {
  assertStringIncludes(readme.toLowerCase(), format.toLowerCase());
  assertStringIncludes(guide.toLowerCase(), format.toLowerCase());
}
for (const term of ["systemd", "tar.gz", "秘密"]) {
  assertStringIncludes(readme.toLowerCase(), term.toLowerCase());
  assertStringIncludes(guide.toLowerCase(), term.toLowerCase());
}
assertStringIncludes(guide, "${DB_PASSWORD}");
assertStringIncludes(exampleReadme, "schema v4 managed App");
assertStringIncludes(appYaml, "schema_version: 4");
assertStringIncludes(appYaml, "format: yaml");
assertStringIncludes(appYaml, "kind: config");
assertStringIncludes(appYaml, "type: systemd");
assertStringIncludes(appYaml, "kind: service");

assertStringIncludes(appYaml, "unit: nginx.service");
assertStringIncludes(appYaml, "on_deploy: none");
assertStringIncludes(appYaml, "run_as: ubuntu");
assertStringIncludes(jxServer, "schema_version: 4");
assertStringIncludes(jxServer, "run_as: ubuntu");
assertStringIncludes(jxServer, "kind: service");
assertStringIncludes(jxServer, "kind: versioned");
assertStringIncludes(jxServer, "scripts: {}");
assertStringIncludes(jxServer, "unit: jx-server.service");
assertStringIncludes(jxServer, "working_directory: current");
assertStringIncludes(jxServer, "command: /usr/bin/java");
assertStringIncludes(jxServer, 'args: ["-jar", "jx-server.jar"]');
assertStringIncludes(jxServer, "on_deploy: restart");
assertStringIncludes(jxServer, "daemon_reload: true");
assert(!jxServer.includes("hooks:"));
assertStringIncludes(jxWeb, "schema_version: 4");
assertStringIncludes(jxWeb, "kind: versioned");
assertStringIncludes(jxWeb, "run_as: ubuntu");
assertStringIncludes(release, 'packageKind !== "validated-directory"');
assertStringIncludes(release, "原子切换 latest");
