import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join } from "jsr:@std/path@1.1.6";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { buildDeploymentBundle } from "../../src/deployment_bundle.ts";
import { PreflightError } from "../../src/errors.ts";
import {
  REMOTE_CONFIG_UPDATER_BUNDLE_PATH,
  REMOTE_CONFIG_UPDATER_SOURCE,
} from "../../src/remote_runtime/artifact.ts";

async function tarMembers(path: string): Promise<Map<string, Uint8Array>> {
  const bytes = await Deno.readFile(path);
  const tar = new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer(),
  );
  const result = new Map<string, Uint8Array>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const string = (start: number, length: number) =>
      new TextDecoder().decode(header.subarray(start, start + length)).split("\0", 1)[0];
    const name = string(0, 100);
    const prefix = string(345, 155);
    const pathValue = prefix.length > 0 ? `${prefix}/${name}` : name;
    const size = Number.parseInt(string(124, 12).trim(), 8);
    offset += 512;
    result.set(pathValue, tar.slice(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  return result;
}

Deno.test("unit/deployment-bundle: 固定布局确定性且原始 tar.gz 字节不变", async () => {
  await withTempDir(async (root) => {
    const original = gzipSync(new TextEncoder().encode("original-app-tar-stream\n"));
    const packagePath = join(root, "app.tar.gz");
    const scriptPath = join(root, "deploy.ts");
    const filePath = join(root, "notice.txt");
    await Deno.writeFile(packagePath, original);
    await Deno.writeTextFile(scriptPath, "Deno.exit(0);\n");
    await Deno.writeTextFile(filePath, "ordinary\n");
    const skeleton = Object.freeze({
      name: "application",
      format: "json" as const,
      content: new TextEncoder().encode(
        '{"password":"__SFO_SECRET_V1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA__"}\n',
      ),
      size: 72,
      sha256: "",
      secretBindings: Object.freeze([]),
    });
    const actualSkeleton = Object.freeze({
      ...skeleton,
      size: skeleton.content.length,
      sha256: createHash("sha256").update(skeleton.content).digest("hex"),
    });
    const options = {
      package: {
        source: packagePath,
        expectedSha256: createHash("sha256").update(original).digest("hex"),
      },
      scripts: [{ source: scriptPath, relativePath: "scripts/deploy.ts", mode: 0o700 }],
      configs: [{ skeleton: actualSkeleton, relativePath: "application.skeleton" }],
      ordinaryFiles: [{ source: filePath, relativePath: "files/notice.txt" }],
    };
    const first = await buildDeploymentBundle({
      ...options,
      destination: join(root, "one.tar.gz"),
    });
    const second = await buildDeploymentBundle({
      ...options,
      destination: join(root, "two.tar.gz"),
    });
    assertEquals(first.sha256, second.sha256);
    assertEquals(await Deno.readFile(first.path), await Deno.readFile(second.path));
    assertEquals(first.manifest.entries.map((entry) => [entry.path, entry.purpose, entry.mode]), [
      ["configs/application.skeleton", "config-skeleton", "0600"],
      ["configs/application.skeleton.bindings.json", "config-bindings", "0600"],
      ["files/notice.txt", "file", "0600"],
      ["package/app.tar.gz", "package", "0600"],
      ["scripts/deploy.ts", "script", "0700"],
      [`scripts/${REMOTE_CONFIG_UPDATER_BUNDLE_PATH}`, "script", "0700"],
    ]);
    const members = await tarMembers(first.path);
    assertEquals([...members.keys()], [
      "manifest.json",
      "configs/application.skeleton",
      "configs/application.skeleton.bindings.json",
      "files/notice.txt",
      "package/app.tar.gz",
      "scripts/deploy.ts",
      `scripts/${REMOTE_CONFIG_UPDATER_BUNDLE_PATH}`,
    ]);
    assertEquals(
      [...members.get("package/app.tar.gz")!],
      [...original],
    );
    const manifestText = new TextDecoder().decode(members.get("manifest.json"));
    assertEquals(manifestText.includes("correct horse battery staple"), false);
    const runtime = members.get(`scripts/${REMOTE_CONFIG_UPDATER_BUNDLE_PATH}`)!;
    assertEquals(runtime, await Deno.readFile(REMOTE_CONFIG_UPDATER_SOURCE));
    const runtimeText = new TextDecoder().decode(runtime);
    assertEquals(/(?:jsr:|npm:|import\s*\()/u.test(runtimeText), false);
  });
});

Deno.test("unit/deployment-bundle: 危险路径、重复项、链接、大小和篡改失败关闭", async () => {
  await withTempDir(async (root) => {
    const file = join(root, "file");
    await Deno.writeTextFile(file, "payload");
    for (const [index, relativePath] of ["../escape", "/absolute", "a//b", "a\\b"].entries()) {
      await assertRejects(
        () =>
          buildDeploymentBundle({
            destination: join(root, `bad-${index}.tar.gz`),
            ordinaryFiles: [{ source: file, relativePath }],
          }),
        PreflightError,
        "canonical relative POSIX",
      );
    }
    await assertRejects(
      () =>
        buildDeploymentBundle({
          destination: join(root, "duplicate.tar.gz"),
          scripts: [
            { source: file, relativePath: "same.ts" },
            { source: file, relativePath: "scripts/same.ts" },
          ],
        }),
      PreflightError,
      "duplicate member",
    );
    const link = join(root, "link");
    await Deno.symlink(file, link);
    await assertRejects(
      () =>
        buildDeploymentBundle({
          destination: join(root, "link.tar.gz"),
          ordinaryFiles: [{ source: link, relativePath: "link" }],
        }),
      PreflightError,
      "stable regular file",
    );
    const tooLarge = await assertRejects(
      () =>
        buildDeploymentBundle({
          destination: join(root, "size.tar.gz"),
          ordinaryFiles: [{ source: file, relativePath: "file" }],
          maxMemberBytes: 2,
        }),
      PreflightError,
    );
    assertStringIncludes(tooLarge.message, "single-member limit");
    const gzip = join(root, "tampered.tar.gz");
    await Deno.writeFile(gzip, gzipSync(new TextEncoder().encode("tampered")));
    await assertRejects(
      () =>
        buildDeploymentBundle({
          destination: join(root, "digest.tar.gz"),
          package: { source: gzip, expectedSha256: "0".repeat(64) },
        }),
      PreflightError,
      "SHA-256",
    );
  });
});
