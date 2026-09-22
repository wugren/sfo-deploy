import { createHash } from "node:crypto";
import { basename, join } from "jsr:@std/path@1.1.6";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import {
  type DownloadProvider,
  DownloadProviderRegistry,
  type DownloadRequest,
  VerifiedArtifact,
} from "../../src/downloads.ts";
import { PreflightError } from "../../src/errors.ts";
import { PackageCache, type PackageMetadata } from "../../src/package_cache.ts";
import type { PackageSpec } from "../../src/types.ts";

const payload = new TextEncoder().encode("artifact payload\n");
const digest = createHash("sha256").update(payload).digest("hex");
const spec: PackageSpec = Object.freeze({
  provider: "https",
  source: Object.freeze({ url: "https://example.invalid/app.bin" }),
  hashAlgorithm: "sha256",
  hashValue: digest,
});
const metadata: PackageMetadata = Object.freeze({
  kind: "app",
  name: "demo",
  version: "1.0.0",
  cluster: "demo",
});

class StubProvider implements DownloadProvider {
  calls = 0;

  async fetch(
    request: DownloadRequest,
    destination: string,
  ): Promise<VerifiedArtifact> {
    assertEquals(request.expectedHash, digest);
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

function build(root: string, provider = new StubProvider()) {
  const registry = new DownloadProviderRegistry({ https: provider });
  return {
    cache: new PackageCache({ packagesDir: join(root, "packages"), registry }),
    provider,
    target: join(root, "packages", "https", `sha256-${digest}`),
  };
}

Deno.test("unit/package-cache: fetch downloads once then reports cached without remote", async () => {
  await withTempDir(async (root) => {
    const { cache, provider, target } = build(root);
    const first = await cache.fetch(spec, metadata);
    assertEquals(first.status, "downloaded");
    assertEquals(first.path, target);
    assertEquals(await Deno.readFile(target), payload);

    const second = await cache.fetch(spec, metadata);
    assertEquals(second.status, "cached");
    assertEquals(provider.calls, 1);

    const meta = JSON.parse(await Deno.readTextFile(`${target}.json`)) as Record<string, unknown>;
    assertEquals(meta.schema_version, 1);
    assertEquals((meta.records as { name: string }[]).at(-1)?.name, "demo");
  });
});

Deno.test("unit/package-cache: prepare is local-only for deploy and fallback otherwise", async () => {
  await withTempDir(async (root) => {
    const { cache, provider, target } = build(root);
    await Deno.mkdir(join(root, "out"), { recursive: true });
    const missing = await assertRejects(
      () => cache.prepare(spec, join(root, "out", "a.bin"), "local-only", metadata),
      PreflightError,
      "Run first",
    );
    assertStringIncludes(missing.message, "--app demo");
    assertEquals(provider.calls, 0);

    const artifact = await cache.prepare(
      spec,
      join(root, "out", "b.bin"),
      "remote-fallback",
      metadata,
    );
    assertEquals(provider.calls, 1);
    assertEquals(await Deno.readFile(artifact.path), payload);
    await artifact.cleanup();
    await Deno.stat(target);

    const cached = await cache.prepare(
      spec,
      join(root, "out", "c.bin"),
      "local-only",
      metadata,
    );
    assertEquals(provider.calls, 1);
    assertEquals(await Deno.readFile(cached.path), payload);
    await cached.cleanup();
    await Deno.stat(target);
  });
});

Deno.test("unit/package-cache: prepare preserves a pre-existing destination on failure", async () => {
  await withTempDir(async (root) => {
    const { cache } = build(root);
    await Deno.mkdir(join(root, "out"), { recursive: true });
    const destination = join(root, "out", "existing.bin");
    await Deno.writeTextFile(destination, "caller-owned");
    await assertRejects(
      () => cache.prepare(spec, destination, "remote-fallback", metadata),
      Deno.errors.AlreadyExists,
    );
    assertEquals(await Deno.readTextFile(destination), "caller-owned");
  });
});

Deno.test("unit/package-cache: concurrent fetch records metadata without temp collisions", async () => {
  await withTempDir(async (root) => {
    const { cache } = build(root);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => cache.fetch(spec, metadata)),
    );
    assertEquals(results.length, 12);
    for (const result of results) {
      assertEquals(result.path, join(root, "packages", "https", `sha256-${digest}`));
    }
    const meta = JSON.parse(
      await Deno.readTextFile(join(root, "packages", "https", `sha256-${digest}.json`)),
    ) as Record<string, unknown>;
    assertEquals(meta.schema_version, 1);
    assertEquals(Array.isArray(meta.records), true);
    assertEquals((meta.records as unknown[]).length, 12);
  });
});

Deno.test("unit/package-cache: 多实例共享 packagesDir 并发 fetch 不丢审计记录", async () => {
  await withTempDir(async (root) => {
    const registry = new DownloadProviderRegistry({ https: new StubProvider() });
    const packagesDir = join(root, "packages");
    const caches = Array.from(
      { length: 3 },
      () => new PackageCache({ packagesDir, registry }),
    );
    const total = 30;
    const results = await Promise.all(
      Array.from(
        { length: total },
        (_, index) => caches[index % caches.length].fetch(spec, metadata),
      ),
    );
    assertEquals(results.length, total);
    const meta = JSON.parse(
      await Deno.readTextFile(join(root, "packages", "https", `sha256-${digest}.json`)),
    ) as Record<string, unknown>;
    assertEquals(meta.schema_version, 1);
    assertEquals((meta.records as unknown[]).length, total);
  });
});

Deno.test("unit/package-cache: stale fixed-name metadata temp no longer blocks fetch", async () => {
  await withTempDir(async (root) => {
    const { cache, target } = build(root);
    await Deno.mkdir(join(root, "packages", "https"), { recursive: true });
    await Deno.writeTextFile(`${target}.json.tmp`, "stale\n");
    const result = await cache.fetch(spec, metadata);
    assertEquals(result.status, "downloaded");
    assertEquals(await Deno.readFile(target), payload);
  });
});

Deno.test("unit/package-cache: 锁超时写入独立溢出记录，后续持锁写入合并不丢记录", async () => {
  await withTempDir(async (root) => {
    const { cache, target } = build(root);
    const directory = join(root, "packages", "https");
    const metadataPath = `${target}.json`;
    await Deno.mkdir(directory, { recursive: true });
    await Deno.writeTextFile(
      metadataPath,
      JSON.stringify({
        schema_version: 1,
        provider: "https",
        source: spec.source,
        hash_algorithm: "sha256",
        hash_value: digest,
        cached_at: new Date().toISOString(),
        records: [{
          kind: "app",
          name: "seed",
          version: null,
          cluster: null,
          fetched_at: new Date().toISOString(),
        }],
      }, undefined, 2),
    );
    const lockDir = `${metadataPath}.lock`;
    await Deno.mkdir(lockDir, { mode: 0o700 });

    const timedOut = await cache.fetch(spec, metadata);
    assertEquals(timedOut.status, "downloaded");
    const afterTimeout = JSON.parse(await Deno.readTextFile(metadataPath)) as {
      records: unknown[];
    };
    assertEquals(afterTimeout.records.length, 1);
    assertEquals(overflowFiles(directory).length, 1);

    await Deno.remove(lockDir, { recursive: true });
    const merged = await cache.fetch(spec, metadata);
    assertEquals(merged.status, "cached");
    const finalMetadata = JSON.parse(await Deno.readTextFile(metadataPath)) as {
      records: unknown[];
    };
    assertEquals(finalMetadata.records.length, 3);
    assertEquals(overflowFiles(directory).length, 0);
  });
});

Deno.test("unit/package-cache: 无溢出时不落文件，损坏溢出保留而正常溢出合并", async () => {
  await withTempDir(async (root) => {
    const { cache, target } = build(root);
    const directory = join(root, "packages", "https");
    const metadataPath = `${target}.json`;
    await Deno.mkdir(directory, { recursive: true });
    await Deno.writeTextFile(
      metadataPath,
      JSON.stringify({
        schema_version: 1,
        provider: "https",
        source: spec.source,
        hash_algorithm: "sha256",
        hash_value: digest,
        cached_at: new Date().toISOString(),
        records: [{
          kind: "app",
          name: "seed",
          version: null,
          cluster: null,
          fetched_at: new Date().toISOString(),
        }],
      }, undefined, 2),
    );

    const clean = await cache.fetch(spec, metadata);
    assertEquals(clean.status, "downloaded");
    const cleanRecords = JSON.parse(await Deno.readTextFile(metadataPath)) as {
      records: unknown[];
    };
    assertEquals(cleanRecords.records.length, 2);
    assertEquals(overflowFiles(directory).length, 0);

    await Deno.writeTextFile(
      `${metadataPath}.overflow-cafe.json`,
      JSON.stringify({
        kind: "app",
        name: "valid-overflow",
        version: null,
        cluster: null,
        fetched_at: new Date().toISOString(),
      }),
    );
    await Deno.writeTextFile(`${metadataPath}.overflow-dead.json`, "{not json");

    const merged = await cache.fetch(spec, metadata);
    assertEquals(merged.status, "cached");
    const finalRecords = JSON.parse(await Deno.readTextFile(metadataPath)) as {
      records: unknown[];
    };
    assertEquals(finalRecords.records.length, 4);
    assertEquals(overflowFiles(directory), [
      `${basename(metadataPath)}.overflow-dead.json`,
    ]);
  });
});

function overflowFiles(directory: string): string[] {
  return [...Deno.readDirSync(directory)]
    .filter((entry) => entry.isFile && entry.name.includes(".overflow-"))
    .map((entry) => entry.name);
}

Deno.test("unit/package-cache: corrupted cache fails closed with removal hint", async () => {
  await withTempDir(async (root) => {
    const { cache, target } = build(root);
    await Deno.mkdir(join(root, "packages", "https"), { recursive: true });
    await Deno.writeTextFile(target, "tampered");
    const error = await assertRejects(
      () => cache.fetch(spec, metadata),
      PreflightError,
      "cache verification failed",
    );
    assertStringIncludes(error.message, "remove the file");
  });
});
