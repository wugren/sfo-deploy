import { join } from "jsr:@std/path@1.1.6";
import { assertEquals, assertStringIncludes, withTempDir } from "../_support/assert.ts";
import { FakeSession, FakeTransport } from "../_support/fake_session.ts";
import { writeCluster } from "../_support/fixtures.ts";
import { createCli } from "../../src/cli.ts";
import type { RemoteSecretState } from "../../src/transport.ts";

class MemoryWriter {
  readonly chunks: string[] = [];
  write(data: Uint8Array): number {
    this.chunks.push(new TextDecoder().decode(data));
    return data.length;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

async function secretCluster(root: string): Promise<string> {
  const directory = await writeCluster(root);
  const clusterPath = join(directory, "cluster.yaml");
  await Deno.writeTextFile(
    clusterPath,
    `${await Deno.readTextFile(
      clusterPath,
    )}secrets:\n  DB_PASSWORD:\n    kind: value\n    machines: [node-a]\n`,
  );
  const secretsPath = join(directory, "secrets.yaml");
  await Deno.writeTextFile(secretsPath, 'DB_PASSWORD: "s3cret_value"\n');
  await Deno.chmod(secretsPath, 0o600);
  return directory;
}

Deno.test("unit/secrets cli: deploy writes declared secrets per machine", async () => {
  await withTempDir(async (root) => {
    const directory = await secretCluster(root);
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const transport = new FakeTransport();
    const cli = createCli({
      configRoot: join(directory, ".."),
      transport,
      stdout,
      stderr,
    });
    const code = await cli(["secrets-deploy", "--cluster", "demo", "--yes", "--json"]);
    assertEquals(code, 0, stderr.text);
    const payload = JSON.parse(stdout.text) as {
      operation: string;
      status: string;
      machines: Array<{ machine: string; entries: Array<{ name: string; status: string }> }>;
    };
    assertEquals(payload.operation, "deploy");
    assertEquals(payload.status, "succeeded");
    assertEquals(payload.machines[0].machine, "node-a");
    assertEquals(payload.machines[0].entries[0], {
      name: "DB_PASSWORD",
      kind: "value",
      status: "written",
    });
    assertEquals(transport.connectCalls, 1);
  });
});

Deno.test("unit/secrets cli: deploy fails closed without secrets.yaml", async () => {
  await withTempDir(async (root) => {
    const directory = await secretCluster(root);
    await Deno.remove(join(directory, "secrets.yaml"));
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const cli = createCli({
      configRoot: join(directory, ".."),
      transport: new FakeTransport(),
      stderr,
      stdout,
    });
    const code = await cli(["secrets-deploy", "--cluster", "demo", "--yes", "--json"]);
    assertEquals(code, 2);
    assertStringIncludes(stderr.text, "Missing cluster secret source");
  });
});

Deno.test("unit/secrets cli: --check reports drift and extras without writing", async () => {
  await withTempDir(async (root) => {
    const directory = await secretCluster(root);
    const drifted: RemoteSecretState = Object.freeze({
      dirMode: "700",
      entries: Object.freeze(["DB_PASSWORD", "STALE"]),
      manifest: Object.freeze([Object.freeze({
        name: "DB_PASSWORD",
        kind: "value",
        sha256: "a".repeat(64),
      })]),
      sha256: Object.freeze({ DB_PASSWORD: "b".repeat(64) }),
    });
    const transport = new FakeTransport(() => {
      const session = new FakeSession();
      session.checkState = drifted;
      return session;
    });
    const stdout = new MemoryWriter();
    const cli = createCli({
      configRoot: join(directory, ".."),
      transport,
      stdout,
    });
    const code = await cli(["secrets-deploy", "--check", "--cluster", "demo", "--json"]);
    assertEquals(code, 3);
    const payload = JSON.parse(stdout.text) as {
      machines: Array<{ issues: Array<{ name: string; kind: string }> }>;
    };
    const issueKinds = payload.machines[0].issues.map((issue) => issue.kind).sort();
    assertEquals(issueKinds, ["drifted", "extra"]);
  });
});

Deno.test("unit/secrets cli: --remove removes declared names", async () => {
  await withTempDir(async (root) => {
    const directory = await secretCluster(root);
    const transport = new FakeTransport();
    const stdout = new MemoryWriter();
    const cli = createCli({
      configRoot: join(directory, ".."),
      transport,
      stdout,
    });
    const code = await cli([
      "secrets-deploy",
      "--remove",
      "DB_PASSWORD",
      "--cluster",
      "demo",
      "--yes",
      "--json",
    ]);
    assertEquals(code, 0);
    const session = transport.sessions[0];
    assertEquals(session?.removedSecrets, ["DB_PASSWORD"]);
  });
});

Deno.test("unit/secrets cli: help and mutually exclusive flags are validated", async () => {
  await withTempDir(async (root) => {
    const directory = await secretCluster(root);
    const stdout = new MemoryWriter();
    const cli = createCli({
      configRoot: join(directory, ".."),
      stdout,
    });
    assertEquals(await cli(["secrets-deploy", "--help"]), 0);
    assertStringIncludes(stdout.text, "secrets-deploy");
    assertStringIncludes(stdout.text, "secrets.yaml");
    assertStringIncludes(stdout.text, "--check");
    assertStringIncludes(stdout.text, "--remove");

    const stderr = new MemoryWriter();
    const invalid = createCli({
      configRoot: join(directory, ".."),
      stderr,
    });
    assertEquals(
      await invalid(["secrets-deploy", "--check", "--remove", "DB_PASSWORD", "--cluster", "demo"]),
      2,
    );
    assertStringIncludes(stderr.text, "cannot be combined with --remove");
  });
});
