import { join } from "jsr:@std/path@1.1.6";
import type {
  ClusterConfig,
  ExecutionPlan,
  Machine,
  ResolvedMachine,
  ScriptInvocation,
} from "../../src/types.ts";

const script: ScriptInvocation = Object.freeze({
  source: "/fixture/action.ts",
  relativePath: "scripts/action.ts",
  permissions: Object.freeze({ run: Object.freeze([]), net: Object.freeze([]) }),
});

export function machine(name: string, address = "10.0.0.1"): Machine {
  return Object.freeze({
    name,
    domains: Object.freeze([]),
    privateIp: Object.freeze([address]),
    publicIp: Object.freeze(["203.0.113.10"]),
    region: "local",
    sshUser: "deploy",
    sshPort: 22,
    scriptRuntime: Object.freeze({ kind: "deno" as const, executable: "deno" }),
    environments: Object.freeze([]),
  });
}

export function resolved(name: string, address = "10.0.0.1"): ResolvedMachine {
  const value = machine(name, address);
  return Object.freeze({
    machine: value,
    address,
    addressKind: "private" as const,
    addresses: Object.freeze([address]),
  });
}

export function plan(machineNames: readonly string[] = ["node-a"]): ExecutionPlan {
  return Object.freeze({
    schemaVersion: 4 as const,
    cluster: "demo",
    requestedAction: "deploy",
    steps: Object.freeze(machineNames.flatMap((name) => {
      const target = resolved(name, name === "node-a" ? "10.0.0.1" : "10.0.0.2");
      return [
        Object.freeze({
          id: `app:${name}/demo:configure`,
          machine: target,
          kind: "app" as const,
          resource: "demo",
          action: "configure",
          scripts: Object.freeze([script]),
          parameters: Object.freeze({ version: "1.0.0" }),
          secretValues: Object.freeze([]),
          secretFiles: Object.freeze([]),
          templates: Object.freeze([]),
          dependsOn: Object.freeze([]),
        }),
        Object.freeze({
          id: `app:${name}/demo:deploy`,
          machine: target,
          kind: "app" as const,
          resource: "demo",
          action: "deploy",
          scripts: Object.freeze([script]),
          parameters: Object.freeze({ version: "1.0.0" }),
          secretValues: Object.freeze([]),
          secretFiles: Object.freeze([]),
          templates: Object.freeze([]),
          dependsOn: Object.freeze([`app:${name}/demo:configure`]),
        }),
      ];
    })),
  });
}

export async function writeCluster(
  root: string,
  options: {
    unknownField?: boolean;
    appV1Inline?: boolean;
    envActions?: readonly string[];
    appConfigure?: boolean;
    envVersion?: string;
  } = {},
): Promise<string> {
  const cluster = join(root, "demo");
  const environmentDirectory = join(cluster, "environments", "base");
  const envActions = options.envActions ?? ["check", "install", "configure"];
  const envScripts = envActions
    .map((action) => `${action}: [{path: scripts/action.ts, permissions: {run: [], net: []}}]`)
    .join("\n  ");
  await Deno.mkdir(join(environmentDirectory, "scripts"), { recursive: true });
  await Deno.mkdir(join(cluster, "apps", "demo", "scripts"), { recursive: true });
  await Deno.mkdir(join(cluster, "apps", "demo", "templates"), { recursive: true });
  await Deno.writeTextFile(
    join(cluster, "cluster.yaml"),
    `schema_version: 2\nname: demo\nexecutor_region: local\nenvironments:\n  base: [node-a]\napps:\n  demo: [node-a]\n${
      options.unknownField ? "unknown: true\n" : ""
    }`,
  );
  await Deno.writeTextFile(
    join(cluster, "machines.yaml"),
    `schema_version: 1\nmachines:\n  - name: node-a\n    private_ip: [10.0.0.1, 10.0.0.2]\n    public_ip: 203.0.113.10\n    region: local\n    ssh_user: deploy\n    ssh_port: 22\n    deno: /usr/bin/deno\n`,
  );
  await Deno.writeTextFile(
    join(environmentDirectory, "environment.yaml"),
    `schema_version: 1\nname: base\nversion: "${
      options.envVersion ?? "1"
    }"\ndepends_on: []\nscripts:\n  ${envScripts}\n`,
  );
  await Deno.writeTextFile(
    join(environmentDirectory, "scripts", "action.ts"),
    "Deno.exit(0);\n",
  );
  const demoHash = "00".repeat(32);
  if (options.appV1Inline) {
    await Deno.writeTextFile(
      join(cluster, "apps", "demo", "app.yaml"),
      `schema_version: 1\nname: demo\nversion: "1.0.0"\npackage:\n  provider: http\n  source: {url: "https://example.invalid/demo.bin"}\n  hash: {algorithm: sha256, value: "${demoHash}"}\ndepends_on: [base]\nmanagement:\n  kind: service\n  name: demo.service\n  tool: systemctl\n`,
    );
  } else {
    await Deno.writeTextFile(
      join(cluster, "app_versions.yaml"),
      `schema_version: 1\napps:\n  demo:\n    version: "1.0.0"\n    package:\n      provider: http\n      source: {url: "https://example.invalid/demo.bin"}\n      hash: {algorithm: sha256, value: "${demoHash}"}\n`,
    );
    await Deno.writeTextFile(
      join(cluster, "apps", "demo", "app.yaml"),
      `schema_version: 1\nname: demo\ninstall_directory: /srv/demo\ndepends_on: [base]\nconfigs:\n  - kind: file\n    source: templates/application.json\n    target: /etc/demo/application.json\n    format: json\nmanagement:\n  kind: service\n  name: demo.service\n  tool: systemctl\n`,
    );
    await Deno.writeTextFile(
      join(cluster, "apps", "demo", "templates", "application.json"),
      "{}\n",
    );
  }
  await Deno.writeTextFile(
    join(cluster, "apps", "demo", "scripts", "action.ts"),
    "Deno.exit(0);\n",
  );
  return cluster;
}

export function emptyCluster(directory: string): ClusterConfig {
  return Object.freeze({
    name: "demo",
    directory,
    executorRegion: "local",
    machines: new Map(),
    environments: new Map(),
    apps: new Map(),
    placements: new Map(),
    secrets: new Map(),
  });
}
