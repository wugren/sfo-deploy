import { join, resolve, toFileUrl } from "jsr:@std/path@1.1.6";

const TEMPLATE_CLUSTER = "examples/eleph-server-multipass/cluster-template";
const MATERIALIZED_CLUSTER = "examples/eleph-server-multipass/clusters/multipass";
const EXPECTED_SCRIPT_COUNT = 13;

function fail(message: string): never {
  console.error(`verify-independent-remote-scripts: ${message}`);
  Deno.exit(1);
}

async function denoCheck(
  files: readonly string[],
  extraArgs: readonly string[] = [],
): Promise<void> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["check", "--frozen", ...extraArgs, ...files],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (output.code !== 0) {
    fail(new TextDecoder().decode(output.stderr) + new TextDecoder().decode(output.stdout));
  }
}

async function externalNegative(): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix: "sfo-deploy-removed-fields-" });
  try {
    const fixture = join(directory, "consumer.ts");
    const executionField = "config" + "Values";
    const stepField = "file" + "Deployments";
    const publicEntry = toFileUrl(resolve("src/mod.ts")).href;
    await Deno.writeTextFile(
      fixture,
      `import type { PreparedExecution, PreparedStep } from ${JSON.stringify(publicEntry)};\n` +
        `declare const execution: PreparedExecution;\n` +
        `declare const step: PreparedStep;\n` +
        `console.log(execution.${executionField}, step.${stepField});\n`,
    );
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["check", "--frozen", fixture],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (output.code === 0) fail("removed prepared-execution fields unexpectedly compiled");
    const diagnostic = new TextDecoder().decode(output.stderr) +
      new TextDecoder().decode(output.stdout);
    for (const field of [executionField, stepField]) {
      if (!diagnostic.includes(field) || !/does not exist|not exist|Property/i.test(diagnostic)) {
        fail(`compiler did not reject the expected removed field ${field}: ${diagnostic}`);
      }
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

async function repositoryClosure(): Promise<void> {
  const files: string[] = [];
  for (const root of ["src", "tests"]) {
    for await (const path of walk(root)) {
      if (path.endsWith(".ts")) files.push(path);
    }
  }
  files.sort();
  await denoCheck(files);
  const lifecycle = await lifecycleScriptSets();
  await assertMatchingLifecycleScripts(lifecycle);
  await denoCheckRemoteScripts(lifecycle.flatMap((set) => set.scripts));
}

async function documentationExamples(): Promise<void> {
  const lifecycle = await lifecycleScriptSets();
  await assertMatchingLifecycleScripts(lifecycle);
  for (const set of lifecycle) {
    for (const path of set.scripts) {
      const source = await Deno.readTextFile(path);
      if (/from\s+["'][^"']*sfo_deploy\.(?:ts|py)["']/.test(source)) {
        fail(`lifecycle script imports framework source: ${path}`);
      }
      if (
        /\bDeploymentContext\b|DEPLOYMENT_CONTEXT_PATH|config_secrets|file_secrets/.test(source)
      ) {
        fail(`lifecycle script references removed secret/context API: ${path}`);
      }
      if (/loadSecrets|load_secrets|DEPLOYMENT_SECRETS_DIR/.test(source)) {
        if (!source.includes("DEPLOYMENT_SECRETS_DIR") && !source.includes("loadSecrets")) {
          fail(`lifecycle script uses loader without secret env boundary: ${path}`);
        }
      }
      if (/DEPLOYMENT_METADATA_PATH/.test(source) && !source.includes("DEPLOYMENT_METADATA_PATH")) {
        fail(`lifecycle script metadata contract is inconsistent: ${path}`);
      }
    }
  }
  await denoCheckRemoteScripts(lifecycle.flatMap((set) => set.scripts));

  const readme = await Deno.readTextFile("README.md");
  const guide = await Deno.readTextFile("docs/guides/sfo-deploy-cluster-configuration.md");
  const exampleReadme = await Deno.readTextFile("examples/eleph-server-multipass/README.md");
  for (
    const [path, text] of [
      ["README.md", readme],
      ["docs/guides/sfo-deploy-cluster-configuration.md", guide],
      ["examples/eleph-server-multipass/README.md", exampleReadme],
    ] as const
  ) {
    if (!text.includes("DEPLOYMENT_SECRETS_DIR") || !text.includes("DEPLOYMENT_METADATA_PATH")) {
      fail(`${path} missing secret loader / step metadata contract`);
    }
    if (!text.includes("sfo_deploy.ts")) {
      fail(`${path} missing removed remote helper boundary`);
    }
  }
  if (!readme.includes("自包含") || !readme.includes("loader")) {
    fail("README missing self-contained script migration guidance");
  }
  if (!guide.includes("0700") || !guide.includes("步骤元数据")) {
    fail("configuration guide missing workspace and step metadata boundary");
  }
  if (!exampleReadme.includes("不会把") || !exampleReadme.includes("loadSecrets")) {
    fail("example README missing zero-framework and migration guidance");
  }
}

interface LifecycleScriptSet {
  readonly root: string;
  readonly scripts: readonly string[];
  readonly byRelativePath: ReadonlyMap<string, string>;
}

async function lifecycleScriptSets(): Promise<readonly LifecycleScriptSet[]> {
  const result: LifecycleScriptSet[] = [];
  for (const root of [TEMPLATE_CLUSTER, MATERIALIZED_CLUSTER]) {
    const scripts: string[] = [];
    for await (const path of walk(root)) {
      if (path.endsWith("/sfo-secret-loader.ts")) {
        fail(`cluster template must not define framework loader: ${path}`);
      }
      if (path.includes("/scripts/") && path.endsWith(".ts")) {
        scripts.push(path);
      }
    }
    scripts.sort();
    if (scripts.length !== EXPECTED_SCRIPT_COUNT) {
      fail(
        `expected ${EXPECTED_SCRIPT_COUNT} lifecycle scripts under ${root}, found ${scripts.length}`,
      );
    }
    result.push({
      root,
      scripts,
      byRelativePath: new Map(scripts.map((path) => [path.slice(root.length + 1), path])),
    });
  }
  return result;
}

async function assertMatchingLifecycleScripts(
  sets: readonly LifecycleScriptSet[],
): Promise<void> {
  const [template, materialized] = sets;
  if (!template || !materialized) fail("template and materialized lifecycle sets are required");
  const templatePaths = [...template.byRelativePath.keys()].sort();
  const materializedPaths = [...materialized.byRelativePath.keys()].sort();
  if (JSON.stringify(templatePaths) !== JSON.stringify(materializedPaths)) {
    fail("template and materialized lifecycle script paths differ");
  }
  for (const relative of templatePaths) {
    const templatePath = template.byRelativePath.get(relative)!;
    const materializedPath = materialized.byRelativePath.get(relative)!;
    if (await Deno.readTextFile(templatePath) !== await Deno.readTextFile(materializedPath)) {
      fail(`materialized lifecycle script differs from template: ${relative}`);
    }
  }
}

async function* walk(root: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory) yield* walk(path);
    else if (entry.isFile) yield path;
  }
}

async function denoCheckRemoteScripts(scripts: readonly string[]): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix: "sfo-deploy-remote-scripts-" });
  try {
    const localScripts: string[] = [];
    for (const [index, source] of scripts.entries()) {
      const target = join(directory, `script-${index}.ts`);
      await Deno.copyFile(source, target);
      localScripts.push(target);
    }
    await Deno.copyFile(
      join(Deno.cwd(), "src/secret_loader/deno.ts"),
      join(directory, "sfo-secret-loader.ts"),
    );
    await denoCheck(localScripts);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
}

const action = Deno.args[0];
if (action === "negative") await externalNegative();
else if (action === "closure") await repositoryClosure();
else if (action === "docs") await documentationExamples();
else fail(`unknown action: ${String(action)}`);
