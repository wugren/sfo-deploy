import { join } from "jsr:@std/path@1.1.6";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";

const RELEASE_SOURCE = "src/remote_runtime/versioned_release.ts";
const TEMPLATE_APP_YAML =
  "examples/eleph-server-multipass/cluster-template/apps/jx-server/app.yaml";
const LIVE_APP_YAML = "examples/eleph-server-multipass/clusters/multipass/apps/jx-server/app.yaml";
const TEMPLATE_WEB_YAML = "examples/eleph-server-multipass/cluster-template/apps/jx-web/app.yaml";
const LIVE_WEB_YAML = "examples/eleph-server-multipass/clusters/multipass/apps/jx-web/app.yaml";

const ALLOW_RUN = [
  "/usr/bin/cat",
  "/usr/bin/chmod",
  "/usr/bin/cp",
  "/usr/bin/find",
  "/usr/bin/install",
  "/usr/bin/ln",
  "/usr/bin/ls",
  "/usr/bin/mkdir",
  "/usr/bin/mv",
  "/usr/bin/rm",
  "/usr/bin/test",
];

interface ScriptResult {
  readonly code: number;
  readonly output: string;
}

async function runRelease(
  root: string,
  metadata: Record<string, unknown>,
  transform?: (source: string) => string,
): Promise<ScriptResult> {
  const script = join(root, "release.ts");
  const original = await Deno.readTextFile(RELEASE_SOURCE);
  await Deno.writeTextFile(script, transform?.(original) ?? original);
  const metadataPath = join(root, "metadata.json");
  await Deno.writeTextFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
  const args = [
    "run",
    "--no-config",
    "--no-remote",
    "--no-npm",
    "--deny-ffi",
    "--allow-env=DEPLOYMENT_METADATA_PATH",
    `--allow-read=${root}`,
    `--allow-write=${root}`,
    `--allow-run=${ALLOW_RUN.join(",")}`,
    script,
  ];
  const result = await new Deno.Command(Deno.execPath(), {
    args,
    cwd: root,
    clearEnv: true,
    env: { DEPLOYMENT_METADATA_PATH: metadataPath },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    output: new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr),
  };
}

function metadata(
  root: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "app",
    resource: "demo",
    action: "deploy",
    deployment: { kind: "versioned" },
    install_directory: join(root, "work"),
    package_path: join(root, "package"),
    package_kind: "validated-directory",
    parameters: { version: "1.0.0" },
    ...overrides,
  };
}

async function makePackage(root: string, content = "app-bytes\n"): Promise<string> {
  const path = join(root, "package");
  await Deno.mkdir(path, { recursive: true });
  await Deno.writeTextFile(join(path, "app.txt"), content);
  return path;
}

async function makeRelease(
  work: string,
  version: string,
  content: string,
  time = 0,
): Promise<void> {
  const path = join(work, version);
  await Deno.mkdir(path, { recursive: true });
  await Deno.writeTextFile(join(path, "app.txt"), content);
  await Deno.writeTextFile(join(path, "VERSION"), `${version}\n`);
  await Deno.writeTextFile(join(work, ".demo.version"), `${version}\n`);
  await Deno.symlink(version, join(work, "latest"));
  if (time) await Deno.utime(path, time, time);
}

Deno.test("integration/versioned release: same version makes no remote changes", async () => {
  await withTempDir(async (root) => {
    const work = join(root, "work");
    await makePackage(root, "same\n");
    await makeRelease(work, "1.0.0", "old\n");
    await Deno.remove(join(work, "latest"));
    const result = await runRelease(
      root,
      metadata(root, {
        parameters: { version: "1.0.0" },
      }),
    );
    assertEquals(result.code, 0, result.output);
    assertStringIncludes(result.output, "版本无变化");
    await assertRejects(() => Deno.stat(join(work, "latest")), Deno.errors.NotFound);
    assertEquals(await Deno.readTextFile(join(work, ".demo.version")), "1.0.0\n");
    assertEquals(await Deno.readTextFile(join(work, "1.0.0", "app.txt")), "old\n");
  });
});

Deno.test("integration/versioned release: stage creates version without latest or marker", async () => {
  await withTempDir(async (root) => {
    const work = join(root, "work");
    await Deno.mkdir(work, { recursive: true });
    await makePackage(root, "staged\n");
    const result = await runRelease(
      root,
      metadata(root, { parameters: { version: "2.0.0" }, action: "stage" }),
    );
    assertEquals(result.code, 0, result.output);
    assertEquals(await Deno.readTextFile(join(work, "2.0.0", "app.txt")), "staged\n");
    assertEquals(await Deno.readTextFile(join(work, "2.0.0", "VERSION")), "2.0.0\n");
    await assertRejects(() => Deno.stat(join(work, "latest")), Deno.errors.NotFound);
    await assertRejects(() => Deno.stat(join(work, ".demo.version")), Deno.errors.NotFound);
  });
});

Deno.test("integration/versioned release: activate consumes staged version", async () => {
  await withTempDir(async (root) => {
    const work = join(root, "work");
    await Deno.mkdir(work, { recursive: true });
    await makePackage(root, "staged\n");
    const staged = await runRelease(
      root,
      metadata(root, { parameters: { version: "2.0.0" }, action: "stage" }),
    );
    assertEquals(staged.code, 0, staged.output);
    const activated = await runRelease(
      root,
      metadata(root, { parameters: { version: "2.0.0" }, action: "activate", keep_versions: 2 }),
    );
    assertEquals(activated.code, 0, activated.output);
    assertEquals((await Deno.readLink(join(work, "latest"))).split("/").at(-1), "2.0.0");
    assertEquals(await Deno.readTextFile(join(work, ".demo.version")), "2.0.0\n");
  });
});

Deno.test("integration/versioned release: different version publishes payload and marker", async () => {
  await withTempDir(async (root) => {
    const work = join(root, "work");
    await Deno.mkdir(work, { recursive: true });
    await makePackage(root, "new-payload\n");
    const result = await runRelease(
      root,
      metadata(root, {
        parameters: { version: "2.0.0" },
      }),
    );
    assertEquals(result.code, 0, result.output);
    assertEquals(await Deno.readTextFile(join(work, "2.0.0", "app.txt")), "new-payload\n");
    assertEquals(await Deno.readTextFile(join(work, "2.0.0", "VERSION")), "2.0.0\n");
    assertEquals((await Deno.readLink(join(work, "latest"))).split("/").at(-1), "2.0.0");
    assertEquals(await Deno.readTextFile(join(work, ".demo.version")), "2.0.0\n");
  });
});

Deno.test("integration/versioned release: marker failure rolls latest and marker back", async () => {
  await withTempDir(async (root) => {
    const work = join(root, "work");
    await makePackage(root, "new\n");
    await makeRelease(work, "1.0.0", "old\n", 1);
    const transform = (source: string) =>
      source.replace(
        "latestSwitched = true;",
        'latestSwitched = true; throw new Error("simulated marker failure");',
      );
    const result = await runRelease(
      root,
      metadata(root, {
        parameters: { version: "2.0.0" },
      }),
      transform,
    );
    assertEquals(result.code, 1, result.output);
    assertStringIncludes(result.output, "simulated marker failure");
    assertEquals((await Deno.readLink(join(work, "latest"))).split("/").at(-1), "1.0.0");
    assertEquals(await Deno.readTextFile(join(work, ".demo.version")), "1.0.0\n");
    assertEquals(await Deno.readTextFile(join(work, "2.0.0", "app.txt")), "new\n");
  });
});

Deno.test("integration/versioned release: success cleans oldest versions", async () => {
  await withTempDir(async (root) => {
    const work = join(root, "work");
    await makePackage(root, "new\n");
    await makeRelease(work, "0.9.0", "old\n", 1);
    await Deno.remove(join(work, "latest"));
    await makeRelease(work, "1.9.0", "current\n", 2);
    await Deno.remove(join(work, "latest"));
    const result = await runRelease(
      root,
      metadata(root, {
        parameters: { version: "2.0.0" },
        keep_versions: 2,
      }),
    );
    assertEquals(result.code, 0, result.output);
    await assertRejects(() => Deno.stat(join(work, "0.9.0")), Deno.errors.NotFound);
    await Deno.stat(join(work, "1.9.0"));
    await Deno.stat(join(work, "2.0.0"));
  });
});

Deno.test("integration/versioned release: release failure never triggers cleanup", async () => {
  await withTempDir(async (root) => {
    const work = join(root, "work");
    await makePackage(root, "new\n");
    await makeRelease(work, "0.9.0", "old\n", 1);
    await Deno.remove(join(work, "latest"));
    await makeRelease(work, "1.9.0", "current\n", 2);
    await Deno.remove(join(work, "latest"));
    const transform = (source: string) =>
      source.replace(
        "latestSwitched = true;",
        'latestSwitched = true; throw new Error("simulated marker failure");',
      );
    const result = await runRelease(
      root,
      metadata(root, {
        parameters: { version: "2.0.0" },
        keep_versions: 1,
      }),
      transform,
    );
    assertEquals(result.code, 1, result.output);
    await Deno.stat(join(work, "0.9.0"));
    await Deno.stat(join(work, "1.9.0"));
    await Deno.stat(join(work, "2.0.0"));
  });
});

Deno.test("integration/versioned release: invalid package kind and symlink root fail closed", async () => {
  await withTempDir(async (root) => {
    const work = join(root, "work");
    await Deno.mkdir(work, { recursive: true });
    await makePackage(root);
    const invalidKind = await runRelease(
      root,
      metadata(root, {
        package_kind: "raw-file",
      }),
    );
    assertEquals(invalidKind.code, 1, invalidKind.output);
    assertStringIncludes(invalidKind.output, "validated package directory");

    const linkRoot = join(root, "link-root");
    await Deno.symlink(work, linkRoot);
    const symlinkRoot = await runRelease(
      root,
      metadata(root, {
        install_directory: linkRoot,
        parameters: { version: "2.0.0" },
      }),
    );
    assertEquals(symlinkRoot.code, 1, symlinkRoot.output);
    assertStringIncludes(symlinkRoot.output, "must not be a symlink");
  });
});

Deno.test("integration/versioned release: Multipass apps use builtin layout and service", async () => {
  const [templateApp, liveApp, templateWeb, liveWeb, release] = await Promise.all([
    Deno.readTextFile(TEMPLATE_APP_YAML),
    Deno.readTextFile(LIVE_APP_YAML),
    Deno.readTextFile(TEMPLATE_WEB_YAML),
    Deno.readTextFile(LIVE_WEB_YAML),
    Deno.readTextFile(RELEASE_SOURCE),
  ]);
  for (const text of [templateApp, liveApp]) {
    assertStringIncludes(text, "kind: versioned");
    assertStringIncludes(text, "working_directory: current");
    assertStringIncludes(text, 'args: ["-jar", "jx-server.jar"]');
    assertStringIncludes(text, "on_deploy: restart");
  }
  for (const text of [templateWeb, liveWeb]) {
    assertStringIncludes(text, "kind: versioned");
    assertStringIncludes(text, "run_as: ubuntu");
  }
  assertStringIncludes(release, "validated-directory");
  assertStringIncludes(release, "原子切换 latest");
});
