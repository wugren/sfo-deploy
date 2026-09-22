import { join } from "jsr:@std/path@1.1.6";

export interface EnvironmentFixture {
  readonly name: string;
  readonly machines: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly version?: string;
  readonly declaredName?: string;
  readonly defaults?: Readonly<Record<string, string>>;
  readonly parameters?: Readonly<Record<string, string>>;
}

export interface AppFixture {
  readonly name: string;
  readonly machines: readonly string[];
  readonly dependsOn?: readonly string[];
}

export interface PlacementFixtureOptions {
  readonly schemaVersion?: 1 | 2;
  readonly machines?: readonly string[];
  readonly environments?: readonly EnvironmentFixture[];
  readonly apps?: readonly AppFixture[];
}

function yamlList(values: readonly string[]): string {
  return `[${values.join(", ")}]`;
}

function yamlRecord(values: Readonly<Record<string, string>> | undefined): string {
  const entries = Object.entries(values ?? {});
  return entries.length === 0
    ? "{}"
    : `{${entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ")}}`;
}

async function writeEnvironment(
  directory: string,
  environment: EnvironmentFixture,
): Promise<void> {
  await Deno.mkdir(join(directory, "scripts"), { recursive: true });
  await Deno.writeTextFile(join(directory, "scripts", "action.ts"), "Deno.exit(0);\n");
  await Deno.writeTextFile(
    join(directory, "environment.yaml"),
    [
      "schema_version: 1",
      `name: ${environment.declaredName ?? environment.name}`,
      `version: ${JSON.stringify(environment.version ?? "1")}`,
      `depends_on: ${yamlList(environment.dependsOn ?? [])}`,
      `defaults: ${yamlRecord(environment.defaults)}`,
      `parameters: ${yamlRecord(environment.parameters)}`,
      "scripts:",
      "  check: [{path: scripts/action.ts, permissions: {run: [], net: []}}]",
      "  install: [{path: scripts/action.ts, permissions: {run: [], net: []}}]",
      "  configure: [{path: scripts/action.ts, permissions: {run: [], net: []}}]",
      "",
    ].filter((line) => line.length > 0).join("\n"),
  );
}

async function writeApp(directory: string, app: AppFixture): Promise<void> {
  await Deno.mkdir(directory, { recursive: true });
  await Deno.mkdir(join(directory, "templates"), { recursive: true });
  await Deno.writeTextFile(
    join(directory, "templates", "application.json"),
    "{}\n",
  );
  await Deno.writeTextFile(
    join(directory, "app.yaml"),
    [
      "schema_version: 1",
      `name: ${app.name}`,
      "install_directory: /srv/demo",
      `depends_on: ${yamlList(app.dependsOn ?? [])}`,
      "configs:",
      "  - kind: file",
      "    source: templates/application.json",
      "    target: /etc/demo/application.json",
      "    format: json",
      "deployment:",
      "  kind: versioned",
      "management:",
      "  kind: service",
      "  name: demo.service",
      "  tool: systemctl",
      "",
    ].join("\n"),
  );
}

async function writeAppVersions(root: string, apps: readonly AppFixture[]): Promise<void> {
  if (apps.length === 0) return;
  const lines = ["schema_version: 1", "apps:"];
  for (const app of apps) {
    lines.push(`  ${app.name}:`);
    lines.push('    version: "1.0.0"');
    lines.push("    package:");
    lines.push("      provider: http");
    lines.push('      source: {url: "https://example.invalid/app.bin"}');
    lines.push(`      hash: {algorithm: sha256, value: "${"00".repeat(32)}"}`);
  }
  lines.push("");
  await Deno.writeTextFile(join(root, "app_versions.yaml"), lines.join("\n"));
}

/** Write a complete v1 or v2 cluster without relying on the production fixture defaults. */
export async function writePlacementCluster(
  root: string,
  options: PlacementFixtureOptions = {},
): Promise<string> {
  const schemaVersion = options.schemaVersion ?? 2;
  const machines = options.machines ?? ["node-a"];
  const environments = options.environments ?? [
    { name: "base", machines: [machines[0]], dependsOn: [] },
  ];
  const apps = options.apps ?? [
    { name: "demo", machines: [machines[0]], dependsOn: ["base"] },
  ];
  const cluster = join(root, `cluster-v${schemaVersion}`);
  await Deno.mkdir(cluster, { recursive: true });

  const environmentMapping = environments
    .map((environment) => `  ${environment.name}: ${yamlList(environment.machines)}`)
    .join("\n");
  const appMapping = apps.map((app) => `  ${app.name}: ${yamlList(app.machines)}`).join("\n");
  await Deno.writeTextFile(
    join(cluster, "cluster.yaml"),
    [
      `schema_version: ${schemaVersion}`,
      "name: placement-fixture",
      "executor_region: local",
      ...(schemaVersion === 2
        ? ["environments:", environmentMapping.length > 0 ? environmentMapping : "  {}"]
        : []),
      "apps:",
      appMapping.length > 0 ? appMapping : "  {}",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    join(cluster, "machines.yaml"),
    [
      "schema_version: 1",
      "machines:",
      ...machines.flatMap((machine, index) => [
        `  - name: ${machine}`,
        `    private_ip: 10.0.0.${index + 1}`,
        "    region: local",
        "    ssh_user: deploy",
        "    deno: /usr/bin/deno",
      ]),
      "",
    ].join("\n"),
  );

  for (const environment of environments) {
    if (schemaVersion === 2) {
      await writeEnvironment(join(cluster, "environments", environment.name), environment);
    } else {
      for (const machine of environment.machines) {
        await writeEnvironment(
          join(cluster, "environments", machine, environment.name),
          environment,
        );
      }
    }
  }
  for (const app of apps) {
    await writeApp(join(cluster, "apps", app.name), app);
  }
  await writeAppVersions(cluster, apps);
  return cluster;
}

export async function replaceInFile(
  path: string,
  from: string,
  to: string,
): Promise<void> {
  const current = await Deno.readTextFile(path);
  if (!current.includes(from)) throw new Error(`fixture text not found in ${path}: ${from}`);
  await Deno.writeTextFile(path, current.replace(from, to));
}
