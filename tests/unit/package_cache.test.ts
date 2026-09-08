import { createHash } from "node:crypto";
import { join } from "jsr:@std/path@1.1.6";
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
      "请先运行",
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

Deno.test("unit/package-cache: corrupted cache fails closed with removal hint", async () => {
  await withTempDir(async (root) => {
    const { cache, target } = build(root);
    await Deno.mkdir(join(root, "packages", "https"), { recursive: true });
    await Deno.writeTextFile(target, "tampered");
    const error = await assertRejects(
      () => cache.fetch(spec, metadata),
      PreflightError,
      "缓存校验失败",
    );
    assertStringIncludes(error.message, "请移除");
  });
});
