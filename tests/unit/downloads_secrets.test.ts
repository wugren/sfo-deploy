import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join } from "jsr:@std/path@1.1.6";
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
  withTempDir,
} from "../_support/assert.ts";
import {
  assertGzipTar,
  type DownloadProvider,
  DownloadProviderRegistry,
  DownloadRequest,
  FilehubDownloadProvider,
  HttpDownloadProvider,
  VerifiedArtifact,
} from "../../src/downloads.ts";
import { ConfigurationError, DownloadError, PreflightError } from "../../src/errors.ts";
import {
  declaredSecretNamesForMachine,
  DEFAULT_SECRETS_DIR,
  prepareSecretDeployments,
  ProjectBindings,
  Redactor,
  validateSecretKind,
  validateSecretName,
} from "../../src/secrets.ts";
import type { SecretDeclaration } from "../../src/types.ts";

const payload = new TextEncoder().encode("verified artifact\n");
const digest = createHash("sha256").update(payload).digest("hex");

Deno.test("unit/download: assertGzipTar accepts gzip and rejects plain files", async () => {
  await withTempDir(async (root) => {
    const gzipFile = join(root, "app.tar.gz");
    await Deno.writeFile(gzipFile, gzipSync(new TextEncoder().encode("tar archive bytes")));
    await assertGzipTar(gzipFile, "测试包");

    const plain = join(root, "plain.bin");
    await Deno.writeFile(plain, new TextEncoder().encode("plain content"));
    await assertRejects(() => assertGzipTar(plain, "测试包"), DownloadError, "tar.gz");

    const short = join(root, "short.bin");
    await Deno.writeFile(short, new TextEncoder().encode("\x1f"));
    await assertRejects(() => assertGzipTar(short, "测试包"), DownloadError, "tar.gz");
  });
});

Deno.test("unit/download: HTTP verifies hash, size and publishes without overwrite", async () => {
  await withTempDir(async (root) => {
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, () => new Response(payload));
    try {
      const destination = join(root, "artifact.bin");
      const request = new DownloadRequest({
        source: { url: `http://127.0.0.1:${server.addr.port}/artifact` },
        hashAlgorithm: "sha256",
        expectedHash: digest,
        maxBytes: payload.length,
      });
      const artifact = await new HttpDownloadProvider().fetch(request, destination);
      assertEquals(await Deno.readFile(destination), payload);
      assertEquals(artifact.hashValue, digest);
      assertEquals(artifact.size, payload.length);
      await assertRejects(
        () => new HttpDownloadProvider().fetch(request, destination),
        DownloadError,
        "拒绝覆盖",
      );
      await artifact.cleanup();
      assert(artifact.cleaned);
    } finally {
      await server.shutdown();
    }
  });
});

Deno.test("unit/download: hash mismatch, credentials, protocol and capacity fail closed", async () => {
  await withTempDir(async (root) => {
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, () => new Response(payload));
    try {
      const provider = new HttpDownloadProvider();
      const url = `http://127.0.0.1:${server.addr.port}/artifact`;
      const wrong = new DownloadRequest({
        source: { url },
        hashAlgorithm: "sha256",
        expectedHash: "00".repeat(32),
      });
      await assertRejects(
        () => provider.fetch(wrong, join(root, "wrong.bin")),
        DownloadError,
        "哈希不匹配",
      );
      await assertRejects(
        () =>
          provider.fetch(
            new DownloadRequest({
              source: { url },
              hashAlgorithm: "sha256",
              expectedHash: digest,
              maxBytes: 1,
            }),
            join(root, "large.bin"),
          ),
        DownloadError,
        "最大字节数",
      );
      await assertRejects(
        () =>
          provider.fetch(
            new DownloadRequest({
              source: { url: "file:///etc/passwd" },
              hashAlgorithm: "sha256",
              expectedHash: digest,
            }),
            join(root, "scheme.bin"),
          ),
        DownloadError,
        "http/https",
      );
      await assertRejects(
        () =>
          provider.fetch(
            new DownloadRequest({
              source: { url: "https://user:secret@example.invalid/a" },
              hashAlgorithm: "sha256",
              expectedHash: digest,
            }),
            join(root, "credentials.bin"),
          ),
        DownloadError,
        "凭据",
      );
    } finally {
      await server.shutdown();
    }
  });
});

Deno.test("unit/download registry: provider and release-source schema are strict", () => {
  const registry = new DownloadProviderRegistry({ http: new HttpDownloadProvider() });
  assertEquals(registry.exportReleaseSource("http", { url: "https://example.invalid/a" }), {
    schema: "http.v1",
    payload: { url: "https://example.invalid/a" },
  });
  assertThrows(() => registry.resolve("missing"), DownloadError);
  assertThrows(() => registry.register("http", new HttpDownloadProvider()), DownloadError);
  assertThrows(
    () =>
      registry.importReleaseSource("http", {
        schema: "filehub.v1",
        payload: { target: "a/b/c/d" },
      }),
    DownloadError,
  );
});

Deno.test("unit/filehub release source: server segment allows one explicit port", () => {
  const registry = new DownloadProviderRegistry({ filehub: new FilehubDownloadProvider() });
  const target = "filehub.mynode.site:8443/eleph-server/0.1.0/jx-server";
  const envelope = registry.exportReleaseSource("filehub", { target });
  assertEquals(envelope, {
    schema: "filehub.v1",
    payload: { target },
  });
  assertEquals(registry.importReleaseSource("filehub", envelope), { target });

  const withoutPort = registry.exportReleaseSource("filehub", {
    target: "filehub.mynode.site/eleph-server/0.1.0/jx-server",
  });
  assertEquals(
    withoutPort.payload,
    { target: "filehub.mynode.site/eleph-server/0.1.0/jx-server" },
  );

  const invalidTargets = [
    "filehub.mynode.site:65536/eleph-server/0.1.0/jx-server",
    "filehub.mynode.site:0/eleph-server/0.1.0/jx-server",
    "filehub.mynode.site:8443/eleph-server/0.1.0",
    "filehub.mynode.site:8443/eleph-server/0.1.0/jx-server/extra",
    "filehub.mynode.site:8443/eleph:server/0.1.0/jx-server",
  ];
  for (const invalidTarget of invalidTargets) {
    assertThrows(
      () => registry.exportReleaseSource("filehub", { target: invalidTarget }),
      DownloadError,
      "规范四段",
    );
  }
});

Deno.test("unit/filehub: direct provider rejects wrong hash and removes staging", async () => {
  if (Deno.build.os === "windows") return;
  await withTempDir(async (root) => {
    const executable = join(root, "filehub");
    const log = join(root, "argv.log");
    const previousPath = Deno.env.get("PATH") ?? "";
    const previousLog = Deno.env.get("FILEHUB_TEST_LOG");
    try {
      await Deno.writeTextFile(
        executable,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$FILEHUB_TEST_LOG"\nprintf "filehub artifact\\n" > "$3"\n',
      );
      await Deno.chmod(executable, 0o755);
      Deno.env.set("PATH", `${root}:${previousPath}`);
      Deno.env.set("FILEHUB_TEST_LOG", log);
      const request = new DownloadRequest({
        source: { target: "owner/repo/channel/artifact" },
        hashAlgorithm: "sha256",
        expectedHash: "00".repeat(32),
      });
      const destination = join(root, "artifact.bin");
      await assertRejects(
        () => new FilehubDownloadProvider().fetch(request, destination),
        DownloadError,
        "哈希不匹配",
      );
      const argv = (await Deno.readTextFile(log)).trimEnd().split("\n");
      assertEquals(argv, ["pull", "owner/repo/channel/artifact", argv[2]]);
      assert(argv[2] !== destination);
      assert(argv[2].startsWith(`${root}/.artifact.bin.filehub-`));
      assert(argv[2].endsWith("/artifact.bin"));
      await assertRejects(() => Deno.lstat(destination), Deno.errors.NotFound);
      const leftovers = [...Deno.readDirSync(root)].map((entry) => entry.name).filter((name) =>
        name.startsWith(".artifact.bin.filehub-")
      );
      assertEquals(leftovers, []);
    } finally {
      Deno.env.set("PATH", previousPath);
      if (previousLog === undefined) Deno.env.delete("FILEHUB_TEST_LOG");
      else Deno.env.set("FILEHUB_TEST_LOG", previousLog);
    }
  });
});

Deno.test("unit/filehub: direct provider enforces maxBytes without publishing", async () => {
  if (Deno.build.os === "windows") return;
  await withTempDir(async (root) => {
    const executable = join(root, "filehub");
    const previousPath = Deno.env.get("PATH") ?? "";
    try {
      await Deno.writeTextFile(
        executable,
        '#!/bin/sh\nprintf "filehub artifact\\n" > "$3"\n',
      );
      await Deno.chmod(executable, 0o755);
      Deno.env.set("PATH", `${root}:${previousPath}`);
      const request = new DownloadRequest({
        source: { target: "owner/repo/channel/artifact" },
        hashAlgorithm: "sha256",
        expectedHash: createHash("sha256").update("filehub artifact\n").digest("hex"),
        maxBytes: 1,
      });
      const destination = join(root, "large.bin");
      await assertRejects(
        () => new FilehubDownloadProvider().fetch(request, destination),
        DownloadError,
        "最大字节数",
      );
      await assertRejects(() => Deno.lstat(destination), Deno.errors.NotFound);
      assertEquals(
        [...Deno.readDirSync(root)].filter((entry) => entry.name.startsWith(".large.bin.filehub-"))
          .length,
        0,
      );
    } finally {
      Deno.env.set("PATH", previousPath);
    }
  });
});

Deno.test("unit/filehub: direct provider returns verified metadata and fixed argv", async () => {
  if (Deno.build.os === "windows") return;
  await withTempDir(async (root) => {
    const executable = join(root, "filehub");
    const log = join(root, "argv.log");
    const previousPath = Deno.env.get("PATH") ?? "";
    const previousLog = Deno.env.get("FILEHUB_TEST_LOG");
    try {
      await Deno.writeTextFile(
        executable,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$FILEHUB_TEST_LOG"\nprintf "filehub artifact\\n" > "$3"\n',
      );
      await Deno.chmod(executable, 0o755);
      Deno.env.set("PATH", `${root}:${previousPath}`);
      Deno.env.set("FILEHUB_TEST_LOG", log);
      const expected = createHash("sha256").update("filehub artifact\n").digest("hex");
      const request = new DownloadRequest({
        source: { target: "owner/repo/channel/artifact" },
        hashAlgorithm: "sha256",
        expectedHash: expected,
        maxBytes: 1024,
      });
      const destination = join(root, "artifact.bin");
      const artifact = await new FilehubDownloadProvider().fetch(request, destination);
      const argv = (await Deno.readTextFile(log)).trimEnd().split("\n");
      assertEquals(argv.slice(0, 2), ["pull", "owner/repo/channel/artifact"]);
      assert(argv[2].startsWith(`${root}/.artifact.bin.filehub-`));
      assert(argv[2].endsWith("/artifact.bin"));
      assertEquals(artifact.path, destination);
      assertEquals(artifact.hashAlgorithm, "sha256");
      assertEquals(artifact.hashValue, expected);
      assertEquals(artifact.size, new TextEncoder().encode("filehub artifact\n").byteLength);
      assertEquals(await Deno.readTextFile(destination), "filehub artifact\n");
      await artifact.cleanup();

      await Deno.writeTextFile(executable, "#!/bin/sh\nexit 2\n");
      await Deno.chmod(executable, 0o755);
      await assertRejects(
        () => new FilehubDownloadProvider().fetch(request, join(root, "failed.bin")),
        DownloadError,
        "认证失败",
      );
    } finally {
      Deno.env.set("PATH", previousPath);
      if (previousLog === undefined) Deno.env.delete("FILEHUB_TEST_LOG");
      else Deno.env.set("FILEHUB_TEST_LOG", previousLog);
    }
  });
});

Deno.test("unit/filehub: direct provider pre-abort spawns nothing and leaves no paths", async () => {
  if (Deno.build.os === "windows") return;
  await withTempDir(async (root) => {
    const executable = join(root, "filehub");
    const marker = join(root, "spawned.marker");
    const destination = join(root, "direct.bin");
    const previousPath = Deno.env.get("PATH") ?? "";
    const previousMarker = Deno.env.get("FILEHUB_SPAWN_MARKER");
    try {
      await Deno.writeTextFile(
        executable,
        '#!/bin/sh\ntouch "$FILEHUB_SPAWN_MARKER"\nprintf "unexpected\\n" > "$3"\n',
      );
      await Deno.chmod(executable, 0o755);
      Deno.env.set("PATH", `${root}:${previousPath}`);
      Deno.env.set("FILEHUB_SPAWN_MARKER", marker);
      const controller = new AbortController();
      controller.abort("pre-aborted fixture");
      await assertRejects(
        () =>
          new FilehubDownloadProvider().fetch(
            new DownloadRequest({
              source: { target: "owner/repo/channel/artifact" },
              hashAlgorithm: "sha256",
              expectedHash: "00".repeat(32),
            }),
            destination,
            controller.signal,
          ),
        DownloadError,
        "已取消",
      );
      await assertRejects(() => Deno.lstat(marker), Deno.errors.NotFound);
      await assertRejects(() => Deno.lstat(destination), Deno.errors.NotFound);
      assertEquals(
        [...Deno.readDirSync(root)].filter((entry) => entry.name.startsWith(".direct.bin.filehub-"))
          .length,
        0,
      );
    } finally {
      Deno.env.set("PATH", previousPath);
      if (previousMarker === undefined) Deno.env.delete("FILEHUB_SPAWN_MARKER");
      else Deno.env.set("FILEHUB_SPAWN_MARKER", previousMarker);
    }
  });
});

Deno.test("unit/filehub registry: pre-abort spawns nothing and cleans provider staging", async () => {
  if (Deno.build.os === "windows") return;
  await withTempDir(async (root) => {
    const executable = join(root, "filehub");
    const marker = join(root, "spawned.marker");
    const destination = join(root, "registry.bin");
    const previousPath = Deno.env.get("PATH") ?? "";
    const previousMarker = Deno.env.get("FILEHUB_SPAWN_MARKER");
    const originalMakeTempDir = Deno.makeTempDir;
    let makeTempDirCalls = 0;
    try {
      await Deno.writeTextFile(
        executable,
        '#!/bin/sh\ntouch "$FILEHUB_SPAWN_MARKER"\nprintf "unexpected\\n" > "$3"\n',
      );
      await Deno.chmod(executable, 0o755);
      Deno.env.set("PATH", `${root}:${previousPath}`);
      Deno.env.set("FILEHUB_SPAWN_MARKER", marker);
      const controller = new AbortController();
      controller.abort("pre-aborted fixture");
      Deno.makeTempDir = (options) => {
        makeTempDirCalls++;
        return originalMakeTempDir(options);
      };
      await assertRejects(
        () =>
          new DownloadProviderRegistry().fetch(
            "filehub",
            new DownloadRequest({
              source: { target: "owner/repo/channel/artifact" },
              hashAlgorithm: "sha256",
              expectedHash: "00".repeat(32),
            }),
            destination,
            controller.signal,
          ),
        DownloadError,
        "已取消",
      );
      assertEquals(makeTempDirCalls, 0);
      await assertRejects(() => Deno.lstat(marker), Deno.errors.NotFound);
      await assertRejects(() => Deno.lstat(destination), Deno.errors.NotFound);
      assertEquals(
        [...Deno.readDirSync(root)].filter((entry) =>
          entry.name.startsWith(".registry.bin.provider-") ||
          entry.name.startsWith(".artifact.filehub-")
        ).length,
        0,
      );
    } finally {
      Deno.makeTempDir = originalMakeTempDir;
      Deno.env.set("PATH", previousPath);
      if (previousMarker === undefined) Deno.env.delete("FILEHUB_SPAWN_MARKER");
      else Deno.env.set("FILEHUB_SPAWN_MARKER", previousMarker);
    }
  });
});

Deno.test("unit/download registry: inner provider abort-before-return is never published", async () => {
  await withTempDir(async (root) => {
    const destination = join(root, "inner-abort.bin");
    const controller = new AbortController();
    let returnedArtifact: VerifiedArtifact | undefined;
    const provider: DownloadProvider = {
      async fetch(_request, stagingDestination) {
        await Deno.writeFile(stagingDestination, payload);
        returnedArtifact = new VerifiedArtifact(
          stagingDestination,
          "sha256",
          digest,
          payload.byteLength,
        );
        controller.abort("inner provider completed after cancellation");
        return returnedArtifact;
      },
    };
    const registry = new DownloadProviderRegistry({ fixture: provider });
    await assertRejects(
      () =>
        registry.fetch(
          "fixture",
          new DownloadRequest({
            source: { fixture: true },
            hashAlgorithm: "sha256",
            expectedHash: digest,
            maxBytes: payload.byteLength,
          }),
          destination,
          controller.signal,
        ),
      DownloadError,
      "已取消",
    );
    assert(returnedArtifact?.cleaned);
    await assertRejects(() => Deno.lstat(destination), Deno.errors.NotFound);
    assertEquals(
      [...Deno.readDirSync(root)].filter((entry) =>
        entry.name.startsWith(".inner-abort.bin.provider-")
      ).length,
      0,
    );
  });
});

Deno.test("unit/download registry: cancellation after hard-link removes owned target", async () => {
  await withTempDir(async (root) => {
    const destination = join(root, "link-abort.bin");
    const controller = new AbortController();
    let returnedArtifact: VerifiedArtifact | undefined;
    const provider: DownloadProvider = {
      async fetch(_request, stagingDestination) {
        await Deno.writeFile(stagingDestination, payload);
        returnedArtifact = new VerifiedArtifact(
          stagingDestination,
          "sha256",
          digest,
          payload.byteLength,
        );
        return returnedArtifact;
      },
    };
    const originalLink = Deno.link;
    let linkCalls = 0;
    Deno.link = async (oldpath, newpath) => {
      linkCalls++;
      await originalLink(oldpath, newpath);
      controller.abort("cancelled immediately after publish syscall");
    };
    try {
      await assertRejects(
        () =>
          new DownloadProviderRegistry({ fixture: provider }).fetch(
            "fixture",
            new DownloadRequest({
              source: { fixture: true },
              hashAlgorithm: "sha256",
              expectedHash: digest,
              maxBytes: payload.byteLength,
            }),
            destination,
            controller.signal,
          ),
        DownloadError,
        "已取消",
      );
    } finally {
      Deno.link = originalLink;
    }
    assertEquals(linkCalls, 1);
    assert(returnedArtifact?.cleaned);
    await assertRejects(() => Deno.lstat(destination), Deno.errors.NotFound);
    assertEquals(
      [...Deno.readDirSync(root)].filter((entry) =>
        entry.name.startsWith(".link-abort.bin.provider-")
      ).length,
      0,
    );
  });
});

Deno.test("unit/secrets: lazy selection, missing values and redaction are fail closed", async () => {
  let reads = 0;
  const bindings = new ProjectBindings({
    configSecrets: {
      TOKEN: () => {
        reads++;
        return "sensitive-token";
      },
      EMPTY: "",
    },
  });
  assertEquals(reads, 0);
  assertEquals(await bindings.secret("TOKEN"), "sensitive-token");
  assertEquals(reads, 1);
  await assertRejects(() => bindings.secret("MISSING"), PreflightError, "未绑定");
  await assertRejects(() => bindings.secret("EMPTY"), PreflightError, "非空字符串");
  assertEquals(
    new Redactor(["sensitive-token"]).redact("value=sensitive-token"),
    "value=[REDACTED]",
  );
  assertThrows(() => validateSecretName("bad-name"), ConfigurationError);
});

Deno.test("unit/secrets: placement names honor explicit lists and wildcard expansion", () => {
  const declarations = new Map<string, SecretDeclaration>([
    [
      "DB_PASSWORD",
      Object.freeze({
        name: "DB_PASSWORD",
        kind: "value" as const,
        valueType: "string" as const,
        machines: Object.freeze(["node-a", "node-b"]),
      }),
    ],
    [
      "TLS_KEY",
      Object.freeze({
        name: "TLS_KEY",
        kind: "file" as const,
        valueType: "string" as const,
        machines: Object.freeze(["node-b"]),
      }),
    ],
  ]);
  assertEquals(declaredSecretNamesForMachine(declarations, "node-a"), ["DB_PASSWORD"]);
  assertEquals(declaredSecretNamesForMachine(declarations, "node-b"), ["DB_PASSWORD", "TLS_KEY"]);
  assertEquals(declaredSecretNamesForMachine(declarations, "node-c"), []);
});

Deno.test("unit/secrets: prepareSecretDeployments fixes values and files with hashes", async () => {
  await withTempDir(async (root) => {
    const fileSecret = join(root, "tls.key");
    await Deno.writeTextFile(fileSecret, "private-key-bytes\n");
    const bindings = new ProjectBindings({
      configSecrets: { DB_PASSWORD: "secret-value" },
      fileSecrets: { TLS_KEY: fileSecret },
    });
    const declarations = new Map<string, SecretDeclaration>([
      [
        "DB_PASSWORD",
        Object.freeze({
          name: "DB_PASSWORD",
          kind: "value" as const,
          valueType: "string" as const,
          machines: Object.freeze(["node-a"]),
        }),
      ],
      [
        "TLS_KEY",
        Object.freeze({
          name: "TLS_KEY",
          kind: "file" as const,
          valueType: "string" as const,
          machines: Object.freeze(["node-a"]),
        }),
      ],
    ]);
    const files = await prepareSecretDeployments(declarations, "node-a", bindings, root, {
      prefix: "secret",
    });
    assertEquals(files.map((file) => file.name), ["DB_PASSWORD", "TLS_KEY"]);
    assertEquals(files[0].sha256, createHash("sha256").update("secret-value").digest("hex"));
    assertEquals(await Deno.readTextFile(files[0].source), "secret-value");
    const valueInfo = await Deno.stat(files[0].source);
    assertEquals(valueInfo.mode! & 0o777, 0o600);
    assertEquals(files[1].kind, "file");
    await assertRejects(
      () =>
        prepareSecretDeployments(
          new Map([[
            "MISSING",
            Object.freeze({
              name: "MISSING",
              kind: "value" as const,
              valueType: "string" as const,
              machines: Object.freeze(["node-a"]),
            }),
          ]]),
          "node-a",
          bindings,
          root,
          { prefix: "missing" },
        ),
      PreflightError,
      "未绑定",
    );
    assertEquals(DEFAULT_SECRETS_DIR, "~/.sfo-deploy/secrets/");
    assertEquals(validateSecretKind("value"), "value");
    assertThrows(() => validateSecretKind("env"), ConfigurationError);
  });
});
