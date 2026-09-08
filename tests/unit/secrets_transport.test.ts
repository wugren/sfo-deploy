import { assertRejects, assertStringIncludes, withTempDir } from "../_support/assert.ts";
import { OpenSshRemoteSession, type SpawnedCommand } from "../../src/transport.ts";
import type { RemoteSecretUpload } from "../../src/transport.ts";
import { PreflightError } from "../../src/errors.ts";

type Handler = (command: string, args: readonly string[]) => string;

function factory(handler: Handler, recorded: Array<readonly string[]>) {
  return (command: string, args: readonly string[]): SpawnedCommand => {
    recorded.push([command, ...args]);
    const stdout = handler(command, args);
    const encoder = new TextEncoder();
    return {
      output: () =>
        Promise.resolve({
          code: 0,
          stdout: encoder.encode(stdout),
          stderr: encoder.encode(""),
          signal: null as Deno.Signal | null,
          success: true,
        }),
      kill(): void {},
    };
  };
}

function session(
  recorded: Array<readonly string[]>,
  statMode: string,
): OpenSshRemoteSession {
  return new OpenSshRemoteSession({
    address: "10.0.0.1",
    user: "deploy",
    port: 22,
    knownHosts: "/dev/null",
    sshExecutable: "ssh",
    scpExecutable: "scp",
    connectTimeoutMs: 1_000,
    commandTimeoutMs: 1_000,
    terminateTimeoutMs: 100,
    commandFactory: factory((command, args) => {
      const joined = args.join(" ");
      if (command === "ssh" && joined.includes("$HOME")) return "/home/deploy\n";
      if (joined.includes("'stat'") && joined.includes("'%a'")) return `${statMode}\n`;
      if (joined.includes("cat") && joined.includes("manifest.json")) return "[]\n";
      return "";
    }, recorded),
  });
}

Deno.test("unit/secrets transport: deploySecrets atomically installs file and manifest", async () => {
  await withTempDir(async (root) => {
    const recorded: Array<readonly string[]> = [];
    const client = session(recorded, "700");
    const staged = `${root}/staged`;
    await Deno.writeTextFile(staged, "value");
    const files = [objectFile(staged)];
    const results = await client.deploySecrets(files, "~/.sfo-deploy/secrets/");
    assertEquals(results[0].name, "DB_PASSWORD");
    assertEquals(results[0].status, "written");
    const joined = recorded.map((entry) => entry.join(" "));
    assert(
      joined.some((line) =>
        line.includes("'mkdir'") && line.includes("'-p'") &&
        line.includes("'-m' '0700'") && line.includes("/home/deploy/.sfo-deploy/secrets")
      ),
    );
    assert(
      joined.some((line) =>
        line.includes("'install'") && line.includes("'0600'") &&
        line.includes("/home/deploy/.sfo-deploy/secrets/.DB_PASSWORD.deployment-")
      ),
    );
    assert(joined.some((line) => line.includes("'mv'") && line.includes("'-T'")));
    assert(joined.some((line) => line.includes("manifest.json")));
  });
});

Deno.test("unit/secrets transport: too-wide directory mode fails closed", async () => {
  const recorded: Array<readonly string[]> = [];
  const client = session(recorded, "755");
  const error = await assertRejects(
    () =>
      client.deploySecrets(
        [objectFile("/dev/null")],
        "~/.sfo-deploy/secrets/",
      ),
    PreflightError,
  );
  assertStringIncludes(error.message, "0700");
});

function objectFile(source: string): RemoteSecretUpload {
  const sha256 = "4a44dc15364204a80fe80e9039455cc1608281820fe2b24f1e5233ade6af1dd5";
  return Object.freeze({
    name: "DB_PASSWORD",
    kind: "value",
    source,
    sha256,
  }) as RemoteSecretUpload;
}

import { assert, assertEquals } from "../_support/assert.ts";
