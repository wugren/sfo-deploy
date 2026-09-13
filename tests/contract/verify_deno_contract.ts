import { join, resolve, toFileUrl } from "jsr:@std/path@1.1.6";

function fail(message: string): never {
  console.error(`verify-deno-contract: ${message}`);
  Deno.exit(1);
}

async function oldPathRejected(): Promise<void> {
  const legacy = resolve("src/sfo_deploy/__init__.py");
  try {
    await Deno.stat(legacy);
    fail(`removed Python module still exists: ${legacy}`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const directory = await Deno.makeTempDir({ prefix: "sfo-deploy-old-api-" });
  try {
    const fixture = join(directory, "consumer.ts");
    await Deno.writeTextFile(fixture, `import ${JSON.stringify(toFileUrl(legacy).href)};\n`);
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["check", "--no-config", fixture],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (output.code === 0) fail("removed Python import unexpectedly compiled");
    const diagnostic = new TextDecoder().decode(output.stderr) +
      new TextDecoder().decode(output.stdout);
    if (!/Module not found|Cannot find module|Could not find|does not exist/i.test(diagnostic)) {
      fail(`old path failed for an unexpected reason: ${diagnostic}`);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

async function documentationExamples(): Promise<void> {
  const readme = await Deno.readTextFile("README.md");
  for (
    const required of [
      "deno install --global",
      "--name sfo-deploy",
      "--allow-run=ssh,scp,filehub",
      "deno uninstall --global sfo-deploy",
    ]
  ) {
    if (!readme.includes(required)) fail(`README missing install contract: ${required}`);
  }
  if (/uv run sfo-deploy|pip install|from sfo_deploy import/.test(readme)) {
    fail("README still publishes a removed Python product command/import");
  }
}

async function repositoryClosure(): Promise<void> {
  const roots = ["src", "tests"];
  const files: string[] = [];
  for (const root of roots) {
    for await (const entry of walk(root)) {
      if (entry.includes("app_schema1_removed")) continue;
      if (entry.endsWith(".ts")) files.push(entry);
    }
  }
  files.sort();
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["check", "--frozen", ...files],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (output.code !== 0) fail(new TextDecoder().decode(output.stderr));
}

async function* walk(root: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory) yield* walk(path);
    else if (entry.isFile) yield path;
  }
}

const action = Deno.args[0];
if (action === "old-path") await oldPathRejected();
else if (action === "docs") await documentationExamples();
else if (action === "closure") await repositoryClosure();
else fail(`unknown action: ${String(action)}`);
