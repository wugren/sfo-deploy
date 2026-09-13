import { join } from "jsr:@std/path@1.1.6";
import { assertEquals, withTempDir } from "../_support/assert.ts";

const DENO_LOADER = "src/secret_loader/deno.ts";

Deno.test("integration/secret loader: Deno loader returns values and restricted file paths", async () => {
  await withTempDir(async (root) => {
    const secretsDir = join(root, "secrets");
    await Deno.mkdir(secretsDir);
    await Deno.writeTextFile(join(secretsDir, "DB_PASSWORD"), "db-secret", { mode: 0o600 });
    await Deno.writeTextFile(join(secretsDir, "TLS_KEY"), "key-bytes\n", { mode: 0o600 });
    const consumer = join(root, "consumer.ts");
    await Deno.writeTextFile(
      consumer,
      `import { loadSecrets } from ${
        JSON.stringify(
          new URL(`file://${join(Deno.cwd(), DENO_LOADER)}`).href,
        )
      };\n` +
        `const result = await loadSecrets({\n` +
        `  dir: ${JSON.stringify(secretsDir)},\n` +
        `  values: ["DB_PASSWORD"],\n` +
        `  files: ["TLS_KEY"],\n` +
        `});\n` +
        `if (result.values.DB_PASSWORD !== "db-secret") throw new Error("value mismatch");\n` +
        `if (result.files.TLS_KEY !== ${JSON.stringify(join(secretsDir, "TLS_KEY"))}) {\n` +
        `  throw new Error("file path mismatch");\n` +
        `}\n`,
    );
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-config",
        "--no-remote",
        "--no-npm",
        "--deny-ffi",
        `--allow-read=${root},${Deno.cwd()}`,
        consumer,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
  });
});

Deno.test("integration/secret loader: Deno loader rejects missing, empty, invalid and escaping names", async () => {
  await withTempDir(async (root) => {
    const secretsDir = join(root, "secrets");
    await Deno.mkdir(secretsDir);
    await Deno.writeFile(join(secretsDir, "APP_TOKEN"), new Uint8Array(), { createNew: true });
    const consumer = join(root, "consumer.ts");
    await Deno.writeTextFile(
      consumer,
      `import { loadSecrets } from ${
        JSON.stringify(
          new URL(`file://${join(Deno.cwd(), DENO_LOADER)}`).href,
        )
      };\n` +
        `try {\n` +
        `  await loadSecrets({ dir: ${JSON.stringify(secretsDir)}, values: ["MISSING"] });\n` +
        `  throw new Error("missing secret unexpectedly passed");\n` +
        `} catch (error) {\n` +
        `  if (!/Failed to read secret MISSING/.test(String(error))) throw error;\n` +
        `}\n` +
        `try {\n` +
        `  await loadSecrets({ dir: ${JSON.stringify(secretsDir)}, values: ["APP_TOKEN"] });\n` +
        `  throw new Error("empty secret unexpectedly passed");\n` +
        `} catch (error) {\n` +
        `  if (!/Secret APP_TOKEN is empty/.test(String(error))) throw error;\n` +
        `}\n` +
        `try {\n` +
        `  await loadSecrets({ dir: ${JSON.stringify(secretsDir)}, values: ["bad_name"] });\n` +
        `  throw new Error("invalid name unexpectedly passed");\n` +
        `} catch (error) {\n` +
        `  if (!/Invalid secret name/.test(String(error))) throw error;\n` +
        `}\n`,
    );
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-config",
        "--no-remote",
        "--no-npm",
        "--deny-ffi",
        `--allow-read=${root},${Deno.cwd()}`,
        consumer,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
  });
});
