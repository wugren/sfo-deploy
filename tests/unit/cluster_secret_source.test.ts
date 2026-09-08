import { join } from "jsr:@std/path@1.1.6";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { writeCluster } from "../_support/fixtures.ts";
import { discoverClusterKnownHosts } from "../../src/integration.ts";
import { loadCluster } from "../../src/mod.ts";
import {
  clusterSecretSourcePath,
  loadClusterSecretSource,
  SECRET_SOURCE_FILENAME,
} from "../../src/secrets.ts";

async function withFileSecretCluster(
  root: string,
  secretYaml: string,
): Promise<string> {
  const directory = await writeCluster(root);
  const clusterPath = join(directory, "cluster.yaml");
  await Deno.writeTextFile(
    clusterPath,
    `${await Deno.readTextFile(
      clusterPath,
    )}secrets:\n  DB_PASSWORD:\n    kind: value\n    machines: '*'\n` +
      "  TLS_KEY:\n    kind: file\n    machines: '*'\n",
  );
  const secretsPath = clusterSecretSourcePath(directory);
  await Deno.writeTextFile(secretsPath, secretYaml);
  await Deno.chmod(secretsPath, 0o600);
  const sourceDirectory = join(directory, "files");
  await Deno.mkdir(sourceDirectory);
  const source = join(sourceDirectory, "server.key");
  await Deno.writeTextFile(source, "private-key");
  await Deno.chmod(source, 0o600);
  return directory;
}

Deno.test("unit/secrets source: top-level values map by cluster kind", async () => {
  await withTempDir(async (root) => {
    const directory = await withFileSecretCluster(
      root,
      'DB_PASSWORD: "s3cret_value"\nTLS_KEY: "files/server.key"\n',
    );
    const cluster = await loadCluster(directory);
    const bindings = await loadClusterSecretSource(cluster, directory);
    assertEquals(await bindings.secret("DB_PASSWORD"), "s3cret_value");
    assertStringIncludes(await bindings.resolveFileSecret("TLS_KEY"), "files/server.key");
  });
});

Deno.test("unit/secrets source: rejects wrong mode, missing keys, unknown keys and path escape", async () => {
  if (Deno.build.os === "windows") return;
  await withTempDir(async (root) => {
    const directory = await withFileSecretCluster(
      root,
      'DB_PASSWORD: "s3cret_value"\nTLS_KEY: "files/server.key"\n',
    );
    const cluster = await loadCluster(directory);
    await Deno.chmod(clusterSecretSourcePath(directory), 0o644);
    await assertRejects(
      () => loadClusterSecretSource(cluster, directory),
      Error,
      "权限必须是 0600",
    );

    const secretsPath = clusterSecretSourcePath(directory);
    await Deno.chmod(secretsPath, 0o600);
    await Deno.writeTextFile(secretsPath, 'DB_PASSWORD: "s3cret_value"\n');
    await assertRejects(
      () => loadClusterSecretSource(cluster, directory),
      Error,
      "缺少密钥: TLS_KEY",
    );

    await Deno.writeTextFile(
      secretsPath,
      'DB_PASSWORD: "s3cret_value"\nTLS_KEY: "files/server.key"\nUNKNOWN: "x"\n',
    );
    await assertRejects(
      () => loadClusterSecretSource(cluster, directory),
      Error,
      "未声明密钥",
    );

    await Deno.writeTextFile(
      secretsPath,
      'DB_PASSWORD: "s3cret_value"\nTLS_KEY: "../server.key"\n',
    );
    await assertRejects(
      () => loadClusterSecretSource(cluster, directory),
      Error,
      "不允许 ..",
    );
  });
});

Deno.test("unit/secrets source: missing source is a configuration error", async () => {
  await withTempDir(async (root) => {
    const directory = await withFileSecretCluster(
      root,
      'DB_PASSWORD: "s3cret_value"\nTLS_KEY: "files/server.key"\n',
    );
    const cluster = await loadCluster(directory);
    await Deno.remove(join(directory, SECRET_SOURCE_FILENAME));
    await assertRejects(
      () => loadClusterSecretSource(cluster, directory),
      Error,
      "缺少集群秘密来源",
    );
  });
});

Deno.test("unit/secrets source: discovers regular cluster known_hosts", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root);
    const path = join(directory, "known_hosts");
    assertEquals(await discoverClusterKnownHosts(directory), undefined);
    await Deno.writeTextFile(path, "node ssh-ed25519 AAAA\n");
    assertEquals(await discoverClusterKnownHosts(directory), path);
    await Deno.symlink("missing", `${directory}/known-hosts-link`);
    await Deno.remove(path);
    await Deno.rename(`${directory}/known-hosts-link`, path);
    await assertRejects(
      () => discoverClusterKnownHosts(directory),
      Error,
      "普通文件",
    );
  });
});
