import { join } from "jsr:@std/path@1.1.6";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { ConfigurationError } from "../../src/errors.ts";
import { loadUserConfig } from "../../src/user_config.ts";

Deno.test("unit/user-config: missing file uses default packages dir", async () => {
  await withTempDir(async (home) => {
    const config = await loadUserConfig({ homeDir: home });
    assertEquals(config.schemaVersion, 1);
    assertEquals(config.packagesDir, join(home, ".sfo-deploy", "packages"));
    assertEquals(config.keepVersions, 5);
  });
});

Deno.test("unit/user-config: keep_versions is optional with default and strict bounds", async () => {
  await withTempDir(async (home) => {
    const configDir = join(home, ".sfo-deploy");
    await Deno.mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "config.yaml");

    await Deno.writeTextFile(configPath, "schema_version: 1\nkeep_versions: 3\n");
    assertEquals((await loadUserConfig({ homeDir: home })).keepVersions, 3);
    await Deno.writeTextFile(configPath, "schema_version: 1\nkeep_versions: 100\n");
    assertEquals((await loadUserConfig({ homeDir: home })).keepVersions, 100);

    for (const invalid of ["0", "-1", "101", "2.5"]) {
      await Deno.writeTextFile(configPath, `schema_version: 1\nkeep_versions: ${invalid}\n`);
      const error = await assertRejects(
        () => loadUserConfig({ homeDir: home }),
        ConfigurationError,
      );
      assertStringIncludes(error.message, "keep_versions");
    }

    await Deno.writeTextFile(configPath, 'schema_version: 1\nkeep_versions: "5"\n');
    const typed = await assertRejects(
      () => loadUserConfig({ homeDir: home }),
      ConfigurationError,
    );
    assertStringIncludes(typed.message, "keep_versions");
  });
});

Deno.test("unit/user-config: packages_dir expands ~ and accepts absolute paths", async () => {
  await withTempDir(async (home) => {
    const configDir = join(home, ".sfo-deploy");
    await Deno.mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "config.yaml");
    await Deno.writeTextFile(configPath, "schema_version: 1\npackages_dir: ~/deploy-cache\n");
    assertEquals(
      (await loadUserConfig({ homeDir: home })).packagesDir,
      join(home, "deploy-cache"),
    );
    const absolute = join(home, "cache");
    await Deno.writeTextFile(configPath, `schema_version: 1\npackages_dir: ${absolute}\n`);
    assertEquals((await loadUserConfig({ homeDir: home })).packagesDir, absolute);
  });
});

Deno.test("unit/user-config: unknown fields, bad schema and relative paths fail closed", async () => {
  await withTempDir(async (home) => {
    const configDir = join(home, ".sfo-deploy");
    await Deno.mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "config.yaml");
    await Deno.writeTextFile(
      configPath,
      "schema_version: 1\npackages_dir: rel/cache\nunknown: 1\n",
    );
    const unknown = await assertRejects(
      () => loadUserConfig({ homeDir: home }),
      ConfigurationError,
    );
    assertStringIncludes(unknown.message, "未知字段");

    await Deno.writeTextFile(configPath, "schema_version: 2\n");
    const schema = await assertRejects(() => loadUserConfig({ homeDir: home }), ConfigurationError);
    assertStringIncludes(schema.message, "schema_version");

    await Deno.writeTextFile(configPath, "schema_version: 1\npackages_dir: relative/path\n");
    const relative = await assertRejects(
      () => loadUserConfig({ homeDir: home }),
      ConfigurationError,
    );
    assertStringIncludes(relative.message, "绝对路径");
    assertStringIncludes(relative.message, "~");

    const custom = join(home, "custom.yaml");
    await Deno.writeTextFile(custom, "schema_version: 1\npackages_dir: ~/pkg\n");
    assertEquals(
      (await loadUserConfig({ homeDir: home, configPath: custom })).packagesDir,
      join(home, "pkg"),
    );
  });
});
