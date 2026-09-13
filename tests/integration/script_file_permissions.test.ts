import { join } from "jsr:@std/path@1.1.6";
import { assertEquals, withTempDir } from "../_support/assert.ts";

async function runPermissionScript(
  root: string,
  script: string,
  readPaths: readonly string[],
  writePaths: readonly string[],
): Promise<Deno.CommandOutput> {
  const scriptPath = join(root, "permission-script.ts");
  await Deno.writeTextFile(scriptPath, script);
  return await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-prompt",
      "--no-config",
      "--no-remote",
      "--no-npm",
      "--deny-ffi",
      `--allow-read=${readPaths.join(",")}`,
      writePaths.length > 0 ? `--allow-write=${writePaths.join(",")}` : "--deny-write",
      scriptPath,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
}

Deno.test("integration/script permissions: Deno allows configured read and write paths", async () => {
  await withTempDir(async (root) => {
    const workspace = join(root, "workspace");
    const allowed = join(root, "allowed");
    await Deno.mkdir(workspace);
    await Deno.mkdir(allowed);
    await Deno.writeTextFile(join(allowed, "input.txt"), "seed\n");
    const allowedFile = join(allowed, "output.txt");
    const marker = join(workspace, "allowed-marker");
    const output = await runPermissionScript(
      root,
      `const input = await Deno.readTextFile(${JSON.stringify(join(allowed, "input.txt"))});\n` +
        `if (input !== "seed\\n") throw new Error("read mismatch");\n` +
        `await Deno.writeTextFile(${JSON.stringify(allowedFile)}, "written\\n");\n` +
        `await Deno.writeTextFile(${JSON.stringify(marker)}, "ok\\n");\n`,
      [workspace, allowed],
      [workspace, allowed],
    );
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    assertEquals(await Deno.readTextFile(allowedFile), "written\n");
    assertEquals(await Deno.readTextFile(marker), "ok\n");
  });
});

Deno.test("integration/script permissions: Deno rejects writes outside write paths", async () => {
  await withTempDir(async (root) => {
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await Deno.mkdir(workspace);
    await Deno.mkdir(outside);
    const marker = join(workspace, "denied-marker");
    const output = await runPermissionScript(
      root,
      `try {\n` +
        `  await Deno.writeTextFile(${JSON.stringify(join(outside, "escaped"))}, "bad\\n");\n` +
        `  throw new Error("write unexpectedly succeeded");\n` +
        `} catch (error) {\n` +
        `  if (error instanceof Deno.errors.NotCapable === false &&\n` +
        `      error instanceof Deno.errors.PermissionDenied === false) throw error;\n` +
        `}\n` +
        `await Deno.writeTextFile(${JSON.stringify(marker)}, "denied\\n");\n`,
      [workspace],
      [workspace],
    );
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    let outsideExists = false;
    try {
      outsideExists = (await Deno.lstat(join(outside, "escaped"))).isFile;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    assertEquals(outsideExists, false);
    assertEquals(await Deno.readTextFile(marker), "denied\n");
  });
});

Deno.test("integration/script permissions: read-only authorization cannot delete", async () => {
  await withTempDir(async (root) => {
    const workspace = join(root, "workspace");
    const readOnly = join(root, "read-only");
    await Deno.mkdir(workspace);
    await Deno.mkdir(readOnly);
    const target = join(readOnly, "target.txt");
    await Deno.writeTextFile(target, "keep\n");
    const marker = join(workspace, "delete-denied-marker");
    const output = await runPermissionScript(
      root,
      `try {\n` +
        `  await Deno.remove(${JSON.stringify(target)});\n` +
        `  throw new Error("delete unexpectedly succeeded");\n` +
        `} catch (error) {\n` +
        `  if (error instanceof Deno.errors.NotCapable === false &&\n` +
        `      error instanceof Deno.errors.PermissionDenied === false) throw error;\n` +
        `}\n` +
        `await Deno.writeTextFile(${JSON.stringify(marker)}, "delete-denied\\n");\n`,
      [workspace, readOnly],
      [workspace],
    );
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    assertEquals(await Deno.readTextFile(target), "keep\n");
    assertEquals(await Deno.readTextFile(marker), "delete-denied\n");
  });
});
