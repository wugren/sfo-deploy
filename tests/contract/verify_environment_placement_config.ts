import { parse } from "jsr:@std/yaml@1.2.0";
import { fromFileUrl, join, relative } from "jsr:@std/path@1.1.6";
import { loadCluster } from "../../src/config.ts";
import { ConfigurationError } from "../../src/errors.ts";

const root = fromFileUrl(new URL("../../", import.meta.url));

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function TypeScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) files.push(...await TypeScriptFiles(path));
    else if (entry.isFile && entry.name.endsWith(".ts")) files.push(relative(root, path));
  }
  return files.sort();
}

async function runDenoCheck(paths: readonly string[], cwd = root): Promise<void> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["check", "--frozen", ...paths],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `deno check failed (${output.code}): ${new TextDecoder().decode(output.stderr)}`,
    );
  }
}

async function assertCleanTemplateTree(templateRoot: string): Promise<void> {
  const forbidden: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for await (const entry of Deno.readDir(directory)) {
      const path = join(directory, entry.name);
      const templateRelative = relative(templateRoot, path);
      if (
        (entry.isDirectory && (entry.name === "__pycache__" || entry.name === ".pytest_cache")) ||
        (entry.isFile && /\.(?:pyc|pyo|pyd)$/.test(entry.name))
      ) {
        forbidden.push(templateRelative);
      }
      if (entry.isDirectory) await visit(path);
    }
  };
  await visit(templateRoot);
  try {
    await Deno.lstat(join(templateRoot, "environments", "eleph-server"));
    forbidden.push("environments/eleph-server");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  check(
    forbidden.length === 0,
    `multipass template contains legacy/generated artifacts: ${forbidden.sort().join(", ")}`,
  );
}

function assertOrderedFragments(
  text: string,
  label: string,
  fragments: readonly string[],
): void {
  let offset = 0;
  for (const fragment of fragments) {
    const index = text.indexOf(fragment, offset);
    check(index >= 0, `${label}: missing or out-of-order prepare guard: ${fragment}`);
    offset = index + fragment.length;
  }
}

async function closure(): Promise<void> {
  const files = [
    ...await TypeScriptFiles(join(root, "src")),
    ...await TypeScriptFiles(join(root, "tests")),
    ...await TypeScriptFiles(
      join(root, "examples", "eleph-server-multipass", "cluster-template"),
    ),
  ];
  check(files.length > 0, "repository compile closure selected no TypeScript consumers");
  await runDenoCheck([...new Set(files)]);
}

async function documentationExamples(): Promise<void> {
  const templateRoot = join(root, "examples", "eleph-server-multipass", "cluster-template");
  await assertCleanTemplateTree(templateRoot);
  const cluster = parse(await Deno.readTextFile(join(templateRoot, "cluster.yaml"))) as {
    schema_version?: unknown;
    environments?: Record<string, unknown>;
  };
  check(cluster.schema_version === 2, "multipass cluster template must use schema v2");
  check(
    JSON.stringify(cluster.environments) ===
      JSON.stringify({
        jre: ["eleph-server"],
        mysql: ["eleph-server"],
        redis: ["eleph-server"],
      }),
    "multipass template must declare the complete environment placement mapping",
  );
  for (const name of ["jre", "mysql", "redis"]) {
    const definition = parse(
      await Deno.readTextFile(join(templateRoot, "environments", name, "environment.yaml")),
    ) as { name?: unknown };
    check(definition.name === name, `multipass shared definition name mismatch: ${name}`);
  }

  const shellPrepare = await Deno.readTextFile(
    join(root, "examples", "eleph-server-multipass", "prepare-multipass.sh"),
  );
  check(
    !shellPrepare.includes("cluster-template"),
    "prepare-multipass.sh must not reference the cluster template",
  );
  assertOrderedFragments(shellPrepare, "prepare-multipass.sh", [
    'die "Existing Multipass cluster state is required; prepare no longer builds it',
    'multipass delete --purge "$instance_name"',
    'multipass launch "$ubuntu_image"',
    'scan_host_keys "$address" "$stage_root/known_hosts"',
    'deno run --quiet --allow-read --allow-env=HOME,USERPROFILE "$script_dir/../../src/cli.ts" validate',
    'update_hosts_entry "$address"',
  ]);
  const powerShellPrepare = await Deno.readTextFile(
    join(root, "examples", "eleph-server-multipass", "prepare-multipass.ps1"),
  );
  check(
    !powerShellPrepare.includes("cluster-template"),
    "prepare-multipass.ps1 must not reference the cluster template",
  );
  assertOrderedFragments(powerShellPrepare, "prepare-multipass.ps1", [
    'throw "Existing Multipass cluster state is required; prepare no longer builds it',
    "& multipass delete --purge $InstanceName",
    "& multipass launch $UbuntuImage",
    "Scan-HostKeys -Address $address",
    "& deno run --quiet --allow-read --allow-env=HOME,USERPROFILE $frameworkCli validate",
    "Set-HostsEntry -Address $address",
  ]);

  const documents = [
    "README.md",
    "docs/guides/sfo-deploy-cluster-configuration.md",
    "examples/eleph-server-multipass/README.md",
  ];
  for (const document of documents) {
    const text = await Deno.readTextFile(join(root, document));
    check(
      text.includes("schema_version: 2") || text.includes("schema v2"),
      `${document}: v2 missing`,
    );
    check(text.includes("cluster.yaml.environments"), `${document}: placement mapping missing`);
    check(
      text.includes("environments/<") && text.includes("/environment.yaml"),
      `${document}: shared definition path missing`,
    );
    check(
      text.includes("逐机器") || text.includes("overrides"),
      `${document}: override boundary missing`,
    );
    check(
      text.includes("schema v1") || text.includes("schema_version: 1") ||
        text.includes("cluster v1"),
      `${document}: v1 removal guidance missing`,
    );
    check(
      text.includes("已移除") || text.includes("不再支持") ||
        text.includes("不再接受") || text.includes("不再被当前框架读取"),
      `${document}: v1 removal statement missing`,
    );
    check(
      !text.includes("仍只读兼容") && !text.includes("仍可由当前框架读取"),
      `${document}: v1 read compatibility must not be claimed`,
    );
    check(
      text.includes("不会自动") || text.includes("不自动"),
      `${document}: manual migration boundary missing`,
    );
    check(
      text.includes("无法回退") || text.includes("不能只把版本号") || text.includes("不支持降级"),
      `${document}: no-downgrade boundary missing`,
    );
  }
}

async function v1Rejection(): Promise<void> {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(directory, "environments", "node-a", "base", "scripts"), {
      recursive: true,
    });
    await Deno.mkdir(join(directory, "machines"), { recursive: true });
    await Deno.writeTextFile(
      join(directory, "cluster.yaml"),
      "schema_version: 1\nname: v1\nexecutor_region: local\napps: {}\n",
    );
    await Deno.writeTextFile(
      join(directory, "machines.yaml"),
      "schema_version: 1\nmachines:\n  - name: node-a\n    private_ip: 10.0.0.1\n    region: local\n    ssh_user: deploy\n    deno: /usr/bin/deno\n",
    );
    await Deno.writeTextFile(
      join(directory, "environments", "node-a", "base", "environment.yaml"),
      'schema_version: 1\nname: base\nversion: "1"\ndepends_on: []\nscripts: {}\n',
    );
    let error: Error | undefined;
    try {
      await loadCluster(directory);
    } catch (caught) {
      error = caught as Error;
    }
    check(error instanceof ConfigurationError, "cluster v1 must be rejected as ConfigurationError");
    check(
      (error?.message ?? "").includes("cluster.yaml.schema_version 只支持 2"),
      "cluster v1 rejection must name the v2-only restriction",
    );

    await Deno.remove(join(directory, "environments"), { recursive: true });
    await Deno.writeTextFile(
      join(directory, "cluster.yaml"),
      "schema_version: 2\nname: v1-app\nexecutor_region: local\nenvironments: {}\napps:\n  demo: [node-a]\n",
    );
    await Deno.mkdir(join(directory, "apps", "demo", "scripts"), { recursive: true });
    await Deno.writeTextFile(
      join(directory, "apps", "demo", "app.yaml"),
      'schema_version: 1\nname: demo\nversion: "1.0.0"\npackage:\n  provider: http\n  source: {url: "https://example.invalid/demo.bin"}\n  hash: {algorithm: sha256, value: "' +
        "00".repeat(32) +
        '"}\ndepends_on: []\nscripts:\n  deploy: [{path: scripts/action.ts, permissions: {run: [], net: []}}]\n',
    );
    await Deno.writeTextFile(
      join(directory, "apps", "demo", "scripts", "action.ts"),
      "Deno.exit(0);\n",
    );
    error = undefined;
    try {
      await loadCluster(directory);
    } catch (caught) {
      error = caught as Error;
    }
    check(error instanceof ConfigurationError, "app v1 must be rejected as ConfigurationError");
    check(
      (error?.message ?? "").includes("app[demo].schema_version 只支持 2 或 3"),
      "app v1 rejection must name the v2/v3-only restriction",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

const mode = Deno.args[0];
if (mode === "closure") await closure();
else if (mode === "docs") await documentationExamples();
else if (mode === "v1-rejection") await v1Rejection();
else throw new Error(`usage: verify_environment_placement_config.ts <closure|docs|v1-rejection>`);
