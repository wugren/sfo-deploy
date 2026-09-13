import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
  withTempDir,
} from "../_support/assert.ts";
import {
  backupPathFor,
  DEFAULT_LENGTH_BYTES,
  ensureWritableTarget,
  generateSecretValues,
  parseGenerateOptions,
  parseSecretDeclarations,
  renderSecretsYaml,
  requireNoFileSecrets,
  writeSecretsAtomically,
} from "../../examples/eleph-server-multipass/scripts/generate-cluster-secrets.ts";

const CLUSTER_YAML = `schema_version: 2
name: multipass
environments:
  jre: [eleph-server]
secrets:
  ELEPH_DB_PASSWORD:
    kind: value
    machines: "*"
  ELEPH_REDIS_PASSWORD:
    kind: value
    machines: "*"
  HTTPS_PRIVATE_KEY:
    kind: file
    machines: [eleph-server]
`;

const HEX_64_RE = /^[0-9a-f]{64}$/;

Deno.test("unit/generate-cluster-secrets: parses value and file declarations in order", () => {
  const declarations = parseSecretDeclarations(CLUSTER_YAML);
  assertEquals(declarations.length, 3);
  assertEquals(declarations[0], { name: "ELEPH_DB_PASSWORD", kind: "value" });
  assertEquals(declarations[2], { name: "HTTPS_PRIVATE_KEY", kind: "file" });
  if (!Object.isFrozen(declarations)) throw new Error("declarations should be frozen");
});

Deno.test("unit/generate-cluster-secrets: rejects malformed declarations", () => {
  assertThrows(
    () => parseSecretDeclarations("schema_version: 2\nname: multipass\n"),
    Error,
    "has no secrets declaration",
  );
  assertThrows(
    () => parseSecretDeclarations("schema_version: 2\nsecrets: {}\n"),
    Error,
    "secrets declaration is empty",
  );
  assertThrows(
    () => parseSecretDeclarations("schema_version: 2\nsecrets: [A]\n"),
    Error,
    "secrets must be a mapping",
  );
  assertThrows(
    () => parseSecretDeclarations("secrets:\n  lower_case:\n    kind: value\n"),
    Error,
    "Invalid secret name",
  );
  assertThrows(
    () => parseSecretDeclarations("secrets:\n  DB_PASSWORD:\n    kind: text\n"),
    Error,
    "kind must be value or file",
  );
  assertThrows(
    () => parseSecretDeclarations('secrets:\n  DB_PASSWORD: "value"\n'),
    Error,
    "must be a mapping",
  );
  assertThrows(
    () => parseSecretDeclarations("secrets:\n  DB_PASSWORD:\n    kind: value\nsecrets: {}\n"),
    Error,
    "cluster.yaml is not valid YAML",
  );
});

Deno.test("unit/generate-cluster-secrets: generates hex values only for value secrets", () => {
  const declarations = parseSecretDeclarations(CLUSTER_YAML);
  const values = generateSecretValues(
    declarations,
    DEFAULT_LENGTH_BYTES,
    (count) => new Uint8Array(count).fill(0xab),
  );
  assertEquals([...values.keys()], ["ELEPH_DB_PASSWORD", "ELEPH_REDIS_PASSWORD"]);
  for (const value of values.values()) {
    assertEquals(value, "ab".repeat(DEFAULT_LENGTH_BYTES));
    assertMatch(value, HEX_64_RE);
  }

  const short = generateSecretValues(declarations, 8, (count) => new Uint8Array(count).fill(0x01));
  assertMatch([...short.values()][0], /^[0-9a-f]{16}$/);

  const random = generateSecretValues(declarations);
  for (const value of random.values()) assertMatch(value, HEX_64_RE);
  assertThrows(
    () => generateSecretValues(declarations, 2),
    Error,
    "Value size in bytes must be an integer between 8 and 64",
  );
  assertThrows(
    () => generateSecretValues(declarations, 8, () => new Uint8Array(4)),
    Error,
    "Random source returned 4 bytes",
  );
});

Deno.test("unit/generate-cluster-secrets: refuses to write when file secrets are declared", () => {
  const declarations = parseSecretDeclarations(CLUSTER_YAML);
  assertThrows(() => requireNoFileSecrets(declarations), Error, "HTTPS_PRIVATE_KEY");
  requireNoFileSecrets(parseSecretDeclarations(
    'secrets:\n  DB_PASSWORD:\n    kind: value\n    machines: "*"\n',
  ));
});

Deno.test("unit/generate-cluster-secrets: renders quoted yaml lines and rejects empty values", () => {
  const text = renderSecretsYaml(new Map([["DB_PASSWORD", "deadbeef"]]));
  assertEquals(text, 'DB_PASSWORD: "deadbeef"\n');
  assertThrows(() => renderSecretsYaml(new Map()), Error, "No secret values to write");
  assertThrows(
    () => renderSecretsYaml(new Map([["bad_name", "deadbeef"]])),
    Error,
    "Invalid secret name",
  );
});

Deno.test("unit/generate-cluster-secrets: parses options and rejects unsafe combinations", () => {
  assertEquals(parseGenerateOptions([]), {
    write: false,
    force: false,
    lengthBytes: DEFAULT_LENGTH_BYTES,
  });
  assertEquals(parseGenerateOptions(["--write", "--force", "--length", "16"]), {
    write: true,
    force: true,
    lengthBytes: 16,
  });
  assertThrows(() => parseGenerateOptions(["--unknown"]), Error, "Unknown argument");
  assertThrows(
    () => parseGenerateOptions(["--force"]),
    Error,
    "--force can only be used with --write",
  );
  assertThrows(
    () => parseGenerateOptions(["--write", "--length"]),
    Error,
    "--length requires a byte count",
  );
  assertThrows(
    () => parseGenerateOptions(["--write", "--length", "7"]),
    Error,
    "--length must be between",
  );
  assertThrows(
    () => parseGenerateOptions(["--write", "--length", "65"]),
    Error,
    "--length must be between",
  );
  assertThrows(
    () => parseGenerateOptions(["--write", "--length", "1e2"]),
    Error,
    "--length must be an integer",
  );
});

Deno.test("unit/generate-cluster-secrets: refuses overwrite and backs up only with force", async () => {
  await withTempDir(async (root) => {
    const target = `${root}/secrets.yaml`;
    assertEquals(await ensureWritableTarget(target, { force: false, now: new Date() }), null);

    await Deno.writeTextFile(target, 'DB_PASSWORD: "old-value"\n');
    if (Deno.build.os !== "windows") await Deno.chmod(target, 0o600);
    await assertRejects(
      () => ensureWritableTarget(target, { force: false, now: new Date() }),
      Error,
      "refusing to overwrite",
    );
    assertEquals(await Deno.readTextFile(target), 'DB_PASSWORD: "old-value"\n');

    const now = new Date("2026-09-13T09:54:07.123Z");
    const backup = await ensureWritableTarget(target, { force: true, now });
    assertEquals(backup, backupPathFor(target, now));
    assertEquals(backup, `${target}.bak.2026-09-13T09-54-07-123Z`);
    assertEquals(await Deno.readTextFile(backup!), 'DB_PASSWORD: "old-value"\n');
    if (Deno.build.os !== "windows") {
      assertEquals(((await Deno.stat(backup!)).mode ?? 0) & 0o777, 0o600);
    }

    await assertRejects(
      () => ensureWritableTarget(target, { force: true, now }),
      Error,
      "Backup target already exists",
    );
  });
});

Deno.test("unit/generate-cluster-secrets: writes atomically with 0600 and no temp leftovers", async () => {
  await withTempDir(async (root) => {
    const target = `${root}/secrets.yaml`;
    await writeSecretsAtomically(target, 'DB_PASSWORD: "deadbeef"\n');
    assertEquals(await Deno.readTextFile(target), 'DB_PASSWORD: "deadbeef"\n');
    if (Deno.build.os !== "windows") {
      assertEquals(((await Deno.stat(target)).mode ?? 0) & 0o777, 0o600);
    }
    const names: string[] = [];
    for await (const entry of Deno.readDir(root)) names.push(entry.name);
    assertEquals(names, ["secrets.yaml"]);

    await writeSecretsAtomically(target, 'DB_PASSWORD: "cafebabe"\n');
    assertEquals(await Deno.readTextFile(target), 'DB_PASSWORD: "cafebabe"\n');
  });
});

Deno.test("unit/generate-cluster-secrets: rejects symlinked targets", async () => {
  if (Deno.build.os === "windows") return;
  await withTempDir(async (root) => {
    const real = `${root}/real.yaml`;
    const link = `${root}/secrets.yaml`;
    await Deno.writeTextFile(real, 'DB_PASSWORD: "old"\n');
    await Deno.symlink(real, link);
    await assertRejects(
      () => ensureWritableTarget(link, { force: true, now: new Date() }),
      Error,
      "is not a regular file",
    );
  });
});
