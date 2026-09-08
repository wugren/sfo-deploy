import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join } from "jsr:@std/path@1.1.6";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
  BufferWriter,
  withTempDir,
} from "../_support/assert.ts";
import { writeCluster } from "../_support/fixtures.ts";
import { createCli } from "../../src/cli.ts";
import {
  type DownloadProvider,
  type DownloadRequest,
  VerifiedArtifact,
} from "../../src/downloads.ts";
import { ConfigurationError } from "../../src/errors.ts";
import { CLI_ACTIONS, RunOptions } from "../../src/integration.ts";
import type { Transport } from "../../src/transport.ts";

const payload = gzipSync(new TextEncoder().encode("demo executable jar\n"));
const digest = createHash("sha256").update(payload).digest("hex");

class StubProvider implements DownloadProvider {
  calls = 0;

  async fetch(
    request: DownloadRequest,
    destination: string,
  ): Promise<VerifiedArtifact> {
    this.calls += 1;
    await Deno.writeFile(destination, payload);
    return new VerifiedArtifact(
      destination,
      request.hashAlgorithm,
      request.expectedHash,
      payload.length,
    );
  }
}

async function fixAppHash(cluster: string): Promise<void> {
  const path = join(cluster, "app_versions.yaml");
  await Deno.writeTextFile(path, (await Deno.readTextFile(path)).replace("0".repeat(64), digest));
}

Deno.test("integration/fetch: CLI action downloads app packages and reuses cache", async () => {
  assert(CLI_ACTIONS.includes("fetch"));
  await withTempDir(async (root) => {
    const cluster = await writeCluster(root);
    await fixAppHash(cluster);
    const provider = new StubProvider();
    const stdout = new BufferWriter();
    const cli = createCli({
      configRoot: root,
      homeDir: root,
      stdout,
      stderr: new BufferWriter(),
      downloadProviders: { http: provider },
    });
    assertEquals(await cli(["fetch", "--cluster", "demo", "--json"]), 0);
    const first = JSON.parse(stdout.text()) as Record<string, unknown>;
    assertEquals(first.kind, "fetch");
    assertEquals((first.packages as unknown[]).length, 1);
    const firstPackage = (first.packages as Record<string, unknown>[])[0];
    assertEquals(firstPackage.status, "downloaded");
    assertEquals(firstPackage.app, "demo");
    const target = join(root, ".sfo-deploy", "packages", "http", `sha256-${digest}`);
    assertEquals(firstPackage.path, target);
    await Deno.stat(target);

    const cachedOut = new BufferWriter();
    const cachedCli = createCli({
      configRoot: root,
      homeDir: root,
      stdout: cachedOut,
      stderr: new BufferWriter(),
      downloadProviders: { http: provider },
    });
    assertEquals(await cachedCli(["fetch", "--cluster", "demo", "--app", "demo", "--json"]), 0);
    const second = JSON.parse(cachedOut.text()) as Record<string, unknown>;
    assertEquals((second.packages as { status: string }[])[0].status, "cached");
    assertEquals(provider.calls, 1);
  });
});

Deno.test("integration/fetch: filters, unknown apps and missing config fail cleanly", async () => {
  await withTempDir(async (root) => {
    const cluster = await writeCluster(root);
    await fixAppHash(cluster);
    const cli = createCli({
      configRoot: root,
      homeDir: root,
      stdout: new BufferWriter(),
      stderr: new BufferWriter(),
    });
    const missing = new BufferWriter();
    const missingCli = createCli({
      configRoot: root,
      homeDir: root,
      stdout: new BufferWriter(),
      stderr: missing,
    });
    assertEquals(await missingCli(["fetch", "--cluster", "demo", "--app", "nope"]), 2);
    assertStringIncludes(missing.text(), "未知 App");
    assertEquals(await cli(["fetch", "--cluster", "demo", "--environment", "base"]), 2);
    assertEquals(await cli(["fetch", "--cluster", "demo", "--machine", "node-a"]), 2);
    assertEquals(await cli(["fetch", "--cluster", "demo", "--with-dependencies"]), 2);
    assertEquals(await cli(["fetch", "--release-id", "r1"]), 2);

    assertThrows(
      () =>
        new RunOptions({
          configRoot: root,
          cluster: "demo",
          action: "fetch",
          machines: ["node-a"],
        }),
      ConfigurationError,
      "fetch 仅支持",
    );
    new RunOptions({ configRoot: root, cluster: "demo", action: "fetch", apps: ["demo"] });
  });
});

Deno.test("integration/fetch: packageless apps are skipped without requiring package cache", async () => {
  await withTempDir(async (root) => {
    const cluster = await writeCluster(root);
    await fixAppHash(cluster);
    await Deno.mkdir(join(cluster, "apps", "config", "scripts"), { recursive: true });
    await Deno.writeTextFile(
      join(cluster, "apps", "config", "scripts", "action.ts"),
      "Deno.exit(0);\n",
    );
    await Deno.writeTextFile(
      join(cluster, "apps", "config", "app.yaml"),
      "schema_version: 2\nname: config\npackageless: true\nscripts:\n  check: [{path: scripts/action.ts, permissions: {run: [], net: []}}]\n  configure: [{path: scripts/action.ts, permissions: {run: [], net: []}}]\n",
    );
    await Deno.writeTextFile(
      join(cluster, "cluster.yaml"),
      (await Deno.readTextFile(join(cluster, "cluster.yaml"))).replace(
        "apps:\n  demo: [node-a]",
        "apps:\n  demo: [node-a]\n  config: [node-a]",
      ),
    );
    const provider = new StubProvider();
    const stdout = new BufferWriter();
    const cli = createCli({
      configRoot: root,
      homeDir: root,
      stdout,
      stderr: new BufferWriter(),
      downloadProviders: { http: provider },
    });
    assertEquals(await cli(["fetch", "--cluster", "demo", "--json"]), 0);
    const result = JSON.parse(stdout.text()) as Record<string, unknown>;
    assertEquals(result.packages && (result.packages as unknown[]).length, 1);
    assertEquals(result.apps_without_package, ["config"]);
    assertEquals(provider.calls, 1);
  });
});

Deno.test("integration/fetch: deploy fails preflight with fetch hint and zero side effects", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    const provider = new StubProvider();
    const stderr = new BufferWriter();
    let connects = 0;
    const transport: Transport = {
      connect: () => {
        connects += 1;
        throw new Error("missing cache must not connect");
      },
    };
    const cli = createCli({
      configRoot: root,
      homeDir: root,
      stdout: new BufferWriter(),
      stderr,
      downloadProviders: { http: provider },
      transport,
    });
    assertEquals(await cli(["deploy", "--cluster", "demo", "--yes"]), 3);
    assertStringIncludes(stderr.text(), "sfo-deploy fetch --cluster demo --app demo");
    assertEquals(connects, 0);
    assertEquals(provider.calls, 0);
    await assertRejects(
      () => Deno.stat(join(root, "demo", ".sfo-deploy")),
      Deno.errors.NotFound,
    );
  });
});
