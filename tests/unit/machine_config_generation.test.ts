import { createHash } from "node:crypto";
import { join } from "jsr:@std/path@1.1.6";
import { assertEquals, assertRejects, withTempDir } from "../_support/assert.ts";
import { generateConfigSkeleton } from "../../src/config_generation.ts";
import { PreflightError } from "../../src/errors.ts";
import type { ManagedConfigFile, ManagedConfigFormat } from "../../src/types.ts";

function config(source: string, format: ManagedConfigFormat, privateIp = ["10.2.0.8"]): ManagedConfigFile {
  return Object.freeze({
    name: "machine-config",
    relativePath: `config.${format}`,
    source,
    target: "/etc/demo/config",
    targetRoot: "absolute" as const,
    mode: 0o600,
    variables: Object.freeze([]),
    format,
    secretReferences: new Map([
      ["TOKEN", Object.freeze({ kind: "value" as const, valueType: "string" as const })],
    ]),
    machineReferences: new Map([
      ["db-1", Object.freeze({
        region: "east",
        privateIp: Object.freeze(privateIp),
        publicIp: Object.freeze(["203.0.113.8", "203.0.113.9"]),
      })],
    ]),
    onChange: "none" as const,
  });
}

Deno.test("unit/machine-config: structured formats select private or public IP and preserve secrets", async () => {
  const sources = {
    yaml: 'endpoint: "tcp://${db-1}:5432"\nsecret: "${TOKEN}"\n',
    json: '{"endpoint":"tcp://${db-1}:5432","secret":"${TOKEN}"}',
    toml: 'endpoint = "tcp://${db-1}:5432"\nsecret = "${TOKEN}"\n',
    ini: 'endpoint=tcp://${db-1}:5432\nsecret=${TOKEN}\n',
  } as const;
  for (const format of ["yaml", "json", "toml", "ini"] as const) {
    await withTempDir(async (root) => {
      const source = join(root, `config.${format}`);
      await Deno.writeTextFile(source, sources[format]);
      const local = await generateConfigSkeleton(config(source, format), {}, "east");
      const remote = await generateConfigSkeleton(config(source, format), {}, "west");
      const localText = new TextDecoder().decode(local.content);
      const remoteText = new TextDecoder().decode(remote.content);
      assertEquals(localText.includes("10.2.0.8"), true);
      assertEquals(remoteText.includes("203.0.113.8"), true);
      assertEquals(localText.includes("${db-1}"), false);
      assertEquals(localText.includes("${TOKEN}"), false);
      assertEquals(local.secretBindings.map((item) => item.secret), ["TOKEN"]);
      assertEquals(local.sha256, createHash("sha256").update(local.content).digest("hex"));
      assertEquals(local.sha256 === remote.sha256, false);
    });
  }
});

Deno.test("unit/machine-config: same-region public fallback, missing address and region fail closed", async () => {
  await withTempDir(async (root) => {
    const source = join(root, "config.yaml");
    await Deno.writeTextFile(source, 'endpoint: "${db-1}"\nsecret: "${TOKEN}"\n');
    const fallback = await generateConfigSkeleton(config(source, "yaml", []), {}, "east");
    assertEquals(new TextDecoder().decode(fallback.content).includes("203.0.113.8"), true);
    await assertRejects(
      () => generateConfigSkeleton(config(source, "yaml"), {}),
      PreflightError,
      "target machine region is unavailable",
    );
    const missing = config(source, "yaml");
    const noPublic = {
      ...missing,
      machineReferences: new Map([["db-1", {
        region: "east",
        privateIp: Object.freeze(["10.2.0.8"]),
        publicIp: Object.freeze([]),
      }]]),
    };
    await assertRejects(
      () => generateConfigSkeleton(noPublic, {}, "west"),
      PreflightError,
      "no required public IP",
    );
  });
});

Deno.test("unit/machine-config: nginx only substitutes declared machine names", async () => {
  await withTempDir(async (root) => {
    const source = join(root, "site.conf");
    await Deno.writeTextFile(source, "upstream backend { server ${db-1}:8080; }\n");
    const plain = { ...config(source, "nginx"), secretReferences: new Map() };
    const skeleton = await generateConfigSkeleton(plain, {}, "east");
    assertEquals(new TextDecoder().decode(skeleton.content), "upstream backend { server 10.2.0.8:8080; }\n");
    await Deno.writeTextFile(source, "upstream backend { server ${unknown}:8080; }\n");
    await assertRejects(
      () => generateConfigSkeleton(plain, {}, "east"),
      PreflightError,
      "does not support the placeholder",
    );
  });
});
