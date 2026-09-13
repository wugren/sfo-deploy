import { parse as parseIni } from "jsr:@std/ini@0.225.2";
import { parse as parseToml } from "jsr:@std/toml@1.0.11";
import { parse as parseYaml } from "jsr:@std/yaml@1.2.0";
import { join } from "jsr:@std/path@1.1.6";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { generateConfigSkeleton } from "../../src/config_generation.ts";
import { updateConfig, validateCandidate } from "../../src/remote_runtime/config_updater.ts";
import type { ManagedConfigFile, ManagedConfigFormat } from "../../src/types.ts";

function definition(
  source: string,
  format: ManagedConfigFormat,
  valueType: "string" | "integer" | "boolean" = "string",
  kind: "value" | "file" = "value",
): ManagedConfigFile {
  return Object.freeze({
    name: `config-${format}`,
    relativePath: `config.${format}`,
    source,
    target: `/etc/demo/config.${format}`,
    targetRoot: "absolute",
    mode: 0o600,
    variables: Object.freeze([]),
    format,
    secretReferences: Object.freeze(
      new Map([
        ["PASSWORD", Object.freeze({ kind, valueType })],
      ]),
    ),
    onChange: "none" as const,
  });
}

const sources: Readonly<Record<ManagedConfigFormat, string>> = Object.freeze({
  yaml: "database:\n  password: ${PASSWORD}\n",
  json: '{"database":{"password":"${PASSWORD}"}}\n',
  toml: '[database]\npassword = "${PASSWORD}"\n',
  ini: "[database]\npassword=${PASSWORD}\n",
  nginx: "server {\n  listen 80;\n}\n",
});

function bindingDocument(skeleton: Awaited<ReturnType<typeof generateConfigSkeleton>>) {
  return {
    schema_version: 1,
    config: skeleton.name,
    format: skeleton.format,
    bindings: skeleton.secretBindings.map((binding) => ({
      secret: binding.secret,
      kind: binding.secretKind,
      encoding: binding.encoding,
      type: binding.valueType,
      marker: binding.marker,
      text_marker: binding.textMarker,
    })),
  };
}

Deno.test("integration/config-updater: 四格式特殊字符按完整标量注入并无残留", async () => {
  for (const format of ["yaml", "json", "toml", "ini"] as const) {
    await withTempDir(async (root) => {
      const source = join(root, `source.${format}`);
      const input = join(root, `input.${format}`);
      const bindings = join(root, "bindings.json");
      const secrets = join(root, "secrets");
      const output = join(root, `output.${format}`);
      await Deno.mkdir(secrets);
      await Deno.writeTextFile(source, sources[format]);
      const skeleton = await generateConfigSkeleton(definition(source, format), {});
      await Deno.writeFile(input, skeleton.content);
      await Deno.writeTextFile(bindings, JSON.stringify(bindingDocument(skeleton)));
      const secret = format === "ini" ? "q=u#;:/\\safe" : 'q"u\\o\n世界\t$;[]{}';
      await Deno.writeTextFile(join(secrets, "PASSWORD"), secret);
      await updateConfig({
        format,
        input,
        bindings,
        secrets,
        secretRoot: "/tmp/unused",
        output,
      });
      const rendered = await Deno.readTextFile(output);
      assertEquals(rendered.includes("__SFO_SECRET_"), false);
      const parsed = format === "json"
        ? JSON.parse(rendered)
        : format === "yaml"
        ? parseYaml(rendered)
        : format === "toml"
        ? parseToml(rendered)
        : parseIni(rendered);
      assertEquals((parsed as { database: { password: string } }).database.password, secret);
      assertEquals((await Deno.stat(output)).mode! & 0o777, 0o600);
    });
  }
});

Deno.test("integration/config-updater: 类型、缺失秘密、无效候选和残留 marker 失败关闭", async () => {
  await withTempDir(async (root) => {
    const secrets = join(root, "secrets");
    await Deno.mkdir(secrets);
    const input = join(root, "input.json");
    const bindings = join(root, "bindings.json");
    const output = join(root, "output.json");
    const marker = "__SFO_SECRET_V1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA__";
    const textMarker = "__SFO_SECRET_TEXT_V1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA__";
    await Deno.writeTextFile(input, `{"value":"${marker}"}\n`);
    const manifest = {
      schema_version: 1,
      config: "typed",
      format: "json",
      bindings: [{
        secret: "VALUE",
        kind: "value",
        encoding: "utf8",
        type: "integer",
        marker,
        text_marker: textMarker,
      }],
    };
    await Deno.writeTextFile(bindings, JSON.stringify(manifest));
    await Deno.writeTextFile(join(secrets, "VALUE"), "12");
    await updateConfig({
      format: "json",
      input,
      bindings,
      secrets,
      secretRoot: join(root, "unused"),
      output,
    });
    assertEquals(JSON.parse(await Deno.readTextFile(output)).value, 12);

    await Deno.remove(output);
    await Deno.remove(join(secrets, "VALUE"));
    const missing = await assertRejects(() =>
      updateConfig({
        format: "json",
        input,
        bindings,
        secrets,
        secretRoot: join(root, "unused"),
        output,
      })
    );
    assertStringIncludes(missing.message, "is not readable");

    await Deno.writeTextFile(join(secrets, "VALUE"), "not-an-integer");
    await assertRejects(
      () =>
        updateConfig({
          format: "json",
          input,
          bindings,
          secrets,
          secretRoot: join(root, "unused"),
          output,
        }),
      Error,
      "does not match type integer",
    );

    await Deno.writeTextFile(join(root, "residual"), `x=${marker}\n`);
    await assertRejects(() => validateCandidate(join(root, "residual")), Error, "still contains");
  });
});

Deno.test("integration/config-updater: nginx config passes through without bindings", async () => {
  await withTempDir(async (root) => {
    const source = join(root, "jx-web.conf");
    const input = join(root, "input.conf");
    const bindings = join(root, "bindings.json");
    const output = join(root, "output.conf");
    const nginx = "server {\n  charset utf-8;\n}\n";
    await Deno.writeTextFile(source, nginx);
    const skeleton = await generateConfigSkeleton({
      name: "jx-web",
      relativePath: "jx-web.conf",
      source,
      target: "/etc/nginx/conf.d/jx-web.conf",
      targetRoot: "absolute",
      mode: 0o644,
      variables: Object.freeze([]),
      format: "nginx",
      secretReferences: Object.freeze(new Map()),
      onChange: "reload",
      validator: undefined,
    }, {});
    await Deno.writeFile(input, skeleton.content);
    await Deno.writeTextFile(bindings, JSON.stringify(bindingDocument(skeleton)));
    await updateConfig({
      format: "nginx",
      input,
      bindings,
      secrets: join(root, "unused"),
      secretRoot: join(root, "unused-root"),
      output,
    });
    assertEquals(await Deno.readTextFile(output), nginx);
    assertEquals((await Deno.stat(output)).mode! & 0o777, 0o600);
  });
});

Deno.test("integration/config-updater: 文件秘密只注入稳定路径", async () => {
  await withTempDir(async (root) => {
    const source = join(root, "source.yaml");
    const input = join(root, "input.yaml");
    const bindings = join(root, "bindings.json");
    const secrets = join(root, "stable");
    const output = join(root, "output.yaml");
    await Deno.mkdir(secrets);
    await Deno.writeTextFile(join(secrets, "PASSWORD"), "hidden");
    await Deno.writeTextFile(source, "path: ${PASSWORD}\n");
    const skeleton = await generateConfigSkeleton(
      definition(source, "yaml", "string", "file"),
      {},
    );
    await Deno.writeFile(input, skeleton.content);
    await Deno.writeTextFile(bindings, JSON.stringify(bindingDocument(skeleton)));
    await updateConfig({
      format: "yaml",
      input,
      bindings,
      secrets: join(root, "empty"),
      secretRoot: secrets,
      output,
    });
    const rendered = await Deno.readTextFile(output);
    assertEquals(parseYaml(rendered), { path: join(secrets, "PASSWORD") });
    assertEquals(rendered.includes("hidden"), false);
  });
});

Deno.test("integration/config-updater: 无效候选按格式复解析失败且不写出", async () => {
  const invalid: Readonly<Record<ManagedConfigFormat, string>> = Object.freeze({
    yaml: "value: [unterminated\n",
    json: '{"value":\n',
    toml: "value = [\n",
    ini: "[unterminated\nvalue=x\n",
    nginx: "server { __SFO_SECRET_V1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA__ }\n",
  });
  for (const format of ["yaml", "json", "toml", "ini"] as const) {
    await withTempDir(async (root) => {
      const input = join(root, `invalid.${format}`);
      const bindings = join(root, "bindings.json");
      const secrets = join(root, "secrets");
      const output = join(root, `candidate.${format}`);
      await Deno.mkdir(secrets);
      await Deno.writeTextFile(input, invalid[format]);
      await Deno.writeTextFile(
        bindings,
        JSON.stringify({
          schema_version: 1,
          config: `invalid-${format}`,
          format,
          bindings: [],
        }),
      );
      await assertRejects(
        () =>
          updateConfig({
            format,
            input,
            bindings,
            secrets,
            secretRoot: join(root, "stable"),
            output,
          }),
        Error,
        `Failed to parse the ${format.toUpperCase()} config skeleton`,
      );
      await assertRejects(() => Deno.lstat(output), Deno.errors.NotFound);
    });
  }
});
