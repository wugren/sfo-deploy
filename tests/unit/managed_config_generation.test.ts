import { createHash } from "node:crypto";
import { join } from "jsr:@std/path@1.1.6";
import { assert, assertEquals, assertRejects, withTempDir } from "../_support/assert.ts";
import { configVariableMarker, generateConfigSkeleton } from "../../src/config_generation.ts";
import { PreflightError } from "../../src/errors.ts";
import type { ManagedConfigFile, ManagedConfigFormat } from "../../src/types.ts";

function config(
  source: string,
  format: ManagedConfigFormat,
  valueType: "string" | "integer" | "boolean" = "string",
  kind: "value" | "file" = "value",
): ManagedConfigFile {
  return Object.freeze({
    name: `app-${format}`,
    relativePath: `${format}.tpl`,
    source,
    target: `/etc/demo/app.${format}`,
    targetRoot: "absolute",
    mode: 0o600,
    variables: Object.freeze([Object.freeze({
      name: "PORT",
      parameterPath: Object.freeze(["server", "port"]),
      valueType: "integer" as const,
    })]),
    format,
    secretReferences: Object.freeze(
      new Map([
        ["DB_PASSWORD", Object.freeze({ kind, valueType })],
      ]),
    ),
    onChange: "restart" as const,
  });
}

function versionConfig(
  source: string,
  format: ManagedConfigFormat,
  withSecret = false,
): ManagedConfigFile {
  return Object.freeze({
    name: `app-version-${format}`,
    relativePath: `version.${format}.tpl`,
    source,
    target: `/etc/demo/version.${format}`,
    targetRoot: "absolute",
    mode: 0o600,
    variables: Object.freeze([]),
    format,
    secretReferences: Object.freeze(
      new Map(
        withSecret
          ? [
            [
              "APP_VERSION",
              Object.freeze({ kind: "value" as const, valueType: "string" as const }),
            ],
          ]
          : [],
      ),
    ),
    onChange: "restart" as const,
  });
}

const sources: Readonly<Record<ManagedConfigFormat, string>> = Object.freeze({
  yaml: `database:\n  password: \${DB_PASSWORD}\nserver:\n  port: ${
    configVariableMarker("PORT")
  }\n`,
  json: `{"database":{"password":"\${DB_PASSWORD}"},"server":{"port":"${
    configVariableMarker("PORT")
  }"}}`,
  toml: `[database]\npassword = "\${DB_PASSWORD}"\n[server]\nport = "${
    configVariableMarker("PORT")
  }"\n`,
  ini: `[database]\npassword=\${DB_PASSWORD}\n[server]\nport=${configVariableMarker("PORT")}\n`,
  nginx: "server {\n  listen 80;\n}\n",
});

Deno.test("unit/config-generation: 四格式占位符转换为确定性 marker", async () => {
  for (const format of ["yaml", "json", "toml", "ini"] as const) {
    await withTempDir(async (root) => {
      const source = join(root, `app.${format}`);
      await Deno.writeTextFile(source, sources[format]);
      const first = await generateConfigSkeleton(config(source, format), {
        server: { port: 8443 },
      });
      const second = await generateConfigSkeleton(config(source, format), {
        server: { port: 8443 },
      });
      const text = new TextDecoder().decode(first.content);
      assertStringIncludes(text, "8443");
      assert(!text.includes("DB_PASSWORD"));
      assertStringIncludes(text, "__SFO_SECRET_V1_");
      assertEquals(first.format, format);
      assertEquals(first.sha256, second.sha256);
      assertEquals(first.secretBindings[0].secret, "DB_PASSWORD");
      assertEquals(first.secretBindings[0].encoding, "utf8");
    });
  }
});

function assertStringIncludes(value: string, expected: string): void {
  if (!value.includes(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)} in ${value}`);
  }
}

Deno.test("unit/config-generation: APP_VERSION replaces whole and embedded values", async () => {
  const sources: Readonly<Record<"yaml" | "json" | "toml" | "ini", string>> = Object.freeze({
    yaml: `version: "${"$"}{APP_VERSION}"\nrelease: "demo-${"$"}{APP_VERSION}"\n`,
    json: `{"version":"${"$"}{APP_VERSION}","release":"demo-${"$"}{APP_VERSION}"}`,
    toml: `version = "${"$"}{APP_VERSION}"\nrelease = "demo-${"$"}{APP_VERSION}"\n`,
    ini: `version=${"$"}{APP_VERSION}\nrelease=demo-${"$"}{APP_VERSION}\n`,
  });
  for (const format of ["yaml", "json", "toml", "ini"] as const) {
    await withTempDir(async (root) => {
      const source = join(root, `version.${format}`);
      await Deno.writeTextFile(source, sources[format]);
      const skeleton = await generateConfigSkeleton(
        versionConfig(source, format),
        { version: "1.2.3" },
      );
      const text = new TextDecoder().decode(skeleton.content);
      assertEquals((text.match(/1\.2\.3/g) ?? []).length, 2);
      assert(!text.includes("${APP_VERSION}"));
      assertEquals(skeleton.secretBindings, []);
    });
  }
});

Deno.test("unit/config-generation: APP_VERSION without a version fails closed", async () => {
  await withTempDir(async (root) => {
    const source = join(root, "version.yaml");
    await Deno.writeTextFile(source, `version: "${"$"}{APP_VERSION}"\n`);
    const error = await assertRejects(
      () => generateConfigSkeleton(versionConfig(source, "yaml"), {}),
      PreflightError,
    );
    assertStringIncludes(error.message, "has no valid version");
  });
});

Deno.test("unit/config-generation: APP_VERSION secret takes precedence", async () => {
  await withTempDir(async (root) => {
    const source = join(root, "secret.yaml");
    await Deno.writeTextFile(source, `token: "${"$"}{APP_VERSION}"\n`);
    const skeleton = await generateConfigSkeleton(
      versionConfig(source, "yaml", true),
      { version: "1.2.3" },
    );
    const text = new TextDecoder().decode(skeleton.content);
    assert(!text.includes("1.2.3"));
    assertStringIncludes(text, "__SFO_SECRET_V1_");
    assertEquals(skeleton.secretBindings[0]?.secret, "APP_VERSION");
  });
});

Deno.test("unit/config-generation: APP_VERSION is not supported by nginx", async () => {
  await withTempDir(async (root) => {
    const source = join(root, "version.conf");
    await Deno.writeTextFile(source, "server { version ${APP_VERSION}; }\n");
    const error = await assertRejects(
      () => generateConfigSkeleton(versionConfig(source, "nginx"), { version: "1.2.3" }),
      PreflightError,
    );
    assertStringIncludes(error.message, "does not support the placeholder");
  });
});

Deno.test("unit/config-generation: 整值与嵌入字符串使用不同 marker", async () => {
  await withTempDir(async (root) => {
    const source = join(root, "app.yaml");
    await Deno.writeTextFile(
      source,
      `limit: \${DB_PASSWORD}\ndsn: prefix-\${DB_PASSWORD}-suffix\nserver:\n  port: ${
        configVariableMarker("PORT")
      }\n`,
    );
    const error = await assertRejects(
      () => generateConfigSkeleton(config(source, "yaml", "integer"), { server: { port: 1 } }),
      PreflightError,
    );
    assertStringIncludes(error.message, "can only be a whole-value placeholder");
  });
  await withTempDir(async (root) => {
    const source = join(root, "app.yaml");
    await Deno.writeTextFile(
      source,
      `dsn: prefix-\${DB_PASSWORD}-suffix\nserver:\n  port: ${configVariableMarker("PORT")}\n`,
    );
    const skeleton = await generateConfigSkeleton(config(source, "yaml"), {
      server: { port: 8443 },
    });
    const text = new TextDecoder().decode(skeleton.content);
    assertEquals(text.split("__SFO_SECRET_TEXT_V1_").length - 1, 1);
    assertEquals(skeleton.secretBindings[0].valueType, "string");
  });
});

Deno.test("unit/config-generation: 文件秘密绑定使用 path 编码", async () => {
  await withTempDir(async (root) => {
    const source = join(root, "app.yaml");
    await Deno.writeTextFile(
      source,
      `key: \${DB_PASSWORD}\nserver:\n  port: ${configVariableMarker("PORT")}\n`,
    );
    const skeleton = await generateConfigSkeleton(
      config(source, "yaml", "string", "file"),
      { server: { port: 8443 } },
    );
    assertEquals(skeleton.secretBindings[0].secretKind, "file");
    assertEquals(skeleton.secretBindings[0].encoding, "path");
  });
});

Deno.test("unit/config-generation: 未知、缺席、非法占位符和重复键失败关闭", async () => {
  const cases = [
    {
      text: `password: \${UNDECLARED}\nserver:\n  port: ${configVariableMarker("PORT")}\n`,
      message: "has no declared secret",
    },
    {
      text: `password: none\nserver:\n  port: ${configVariableMarker("PORT")}\n`,
      message: "does not appear in the value",
    },
    {
      text: `server:\n  port: ${configVariableMarker("PORT")}\npassword: \${lower}\n`,
      message: "Invalid placeholder name",
    },
  ] as const;
  for (const testCase of cases) {
    await withTempDir(async (root) => {
      const source = join(root, "app.yaml");
      await Deno.writeTextFile(source, testCase.text);
      const error = await assertRejects(
        () => generateConfigSkeleton(config(source, "yaml"), { server: { port: 1 } }),
        PreflightError,
      );
      assertStringIncludes(error.message, testCase.message);
    });
  }
});

Deno.test("unit/config-generation: JSON 重复键失败关闭", async () => {
  await withTempDir(async (root) => {
    const source = join(root, "app.json");
    await Deno.writeTextFile(
      source,
      `{"database":{"password":"\${DB_PASSWORD}"},"database":{"password":"old"},"server":{"port":"${
        configVariableMarker("PORT")
      }"}}`,
    );
    const error = await assertRejects(
      () => generateConfigSkeleton(config(source, "json"), { server: { port: 1 } }),
      PreflightError,
    );
    assertStringIncludes(error.message, "duplicate key");
  });
});

Deno.test("unit/config-generation: 骨架 SHA-256 与内容一致", async () => {
  await withTempDir(async (root) => {
    const source = join(root, "app.json");
    await Deno.writeTextFile(source, sources.json);
    const skeleton = await generateConfigSkeleton(config(source, "json"), {
      server: { port: 1 },
    });
    assertEquals(
      createHash("sha256").update(skeleton.content).digest("hex"),
      skeleton.sha256,
    );
  });
});

Deno.test("unit/config-generation: nginx raw skeleton preserves UTF-8 and rejects bindings", async () => {
  await withTempDir(async (root) => {
    const source = join(root, "jx-web.conf");
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
    assertEquals(new TextDecoder().decode(skeleton.content), nginx);
    assertEquals(skeleton.secretBindings, []);
    assertEquals(skeleton.format, "nginx");
  });

  await withTempDir(async (root) => {
    const source = join(root, "reserved.conf");
    await Deno.writeTextFile(source, "server { __SFO_CONFIG_VAR_V1_NAME__ }\n");
    await assertRejects(
      () =>
        generateConfigSkeleton({
          name: "jx-web",
          relativePath: "reserved.conf",
          source,
          target: "/etc/nginx/conf.d/jx-web.conf",
          targetRoot: "absolute",
          mode: 0o644,
          variables: Object.freeze([]),
          format: "nginx",
          secretReferences: Object.freeze(new Map()),
          onChange: "reload",
          validator: undefined,
        }, {}),
      PreflightError,
      "framework-reserved placeholder",
    );
  });
});
