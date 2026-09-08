import { createHash } from "node:crypto";
import { join } from "jsr:@std/path@1.1.6";
import { assert, assertEquals, withTempDir } from "../_support/assert.ts";
import { resolved } from "../_support/fixtures.ts";
import { type CommandFactory, OpenSshTransport, type SpawnedCommand } from "../../src/transport.ts";

function output(code = 0, stdout = "", stderr = ""): Deno.CommandOutput {
  return {
    success: code === 0,
    code,
    signal: null,
    stdout: new TextEncoder().encode(stdout),
    stderr: new TextEncoder().encode(stderr),
  };
}

function spawned(result: Deno.CommandOutput | Promise<Deno.CommandOutput>): SpawnedCommand {
  return { output: () => Promise.resolve(result), kill: () => undefined };
}

Deno.test("integration/config-fingerprint: unchanged candidate uses file secret hash for serviceChange", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const fingerprintHash = createHash("sha256").update("secret-file\n").digest("hex");
    let fingerprintExists = false;
    const remoteCalls: string[] = [];
    const factory: CommandFactory = (_command, args) => {
      const remote = String(args.at(-1) ?? "");
      remoteCalls.push(remote);
      if (remote === "exec 'true'") return spawned(output());
      if (remote.includes("printf")) return spawned(output(0, "/home/deploy"));
      if (remote === "exec 'id' '-u'") return spawned(output(0, "0\n"));
      if (remote.includes("'stat' '-c' '%F'")) return spawned(output(0, "regular file\n"));
      if (remote.includes("'stat' '-c' '%s'")) {
        return spawned(output(0, remote.includes("/candidate'") ? "72" : "42"));
      }
      if (remote.includes("'stat' '-c' '%a'")) return spawned(output(0, "600\n"));
      if (remote.includes("'stat' '-c' '%U'")) return spawned(output(0, "root\n"));
      if (remote.includes("'stat' '-c' '%G'")) return spawned(output(0, "root\n"));
      if (remote.includes("'sha256sum'")) {
        return spawned(output(0, `${fingerprintHash}  /home/deploy/.sfo-deploy/secrets/TLS_KEY\n`));
      }
      if (remote.includes("'/usr/bin/test' '-f'") && remote.includes("sfo-secret-hashes")) {
        return spawned(output(fingerprintExists ? 0 : 1));
      }
      if (remote.includes("'cat'") && remote.includes("sfo-secret-hashes")) {
        return spawned(
          output(
            0,
            `${
              JSON.stringify(
                {
                  schema_version: 1,
                  files: { TLS_KEY: fingerprintHash },
                },
                null,
                2,
              )
            }\n`,
          ),
        );
      }
      if (remote.includes("'install'") && remote.includes("sfo-secret-hashes")) {
        fingerprintExists = true;
        return spawned(output());
      }
      return spawned(output());
    };
    const transport = new OpenSshTransport({ knownHosts, commandFactory: factory });
    const session = await transport.connect(resolved("node-a"));
    const workspace = await session.createWorkspace();
    const first = (await session.publishManagedConfigs!([{
      candidate: { name: "config", workspace, path: `${workspace}/candidate` },
      target: "/etc/demo/app.conf",
      mode: 0o600,
      owner: "root",
      group: "root",
      runAs: "deploy",
      secretRoot: "~/.sfo-deploy/secrets",
      secretFiles: ["TLS_KEY"],
    }]))[0];
    assertEquals(first!.changed, false);
    assertEquals(first!.serviceChange, true);
    assertEquals(first!.secretFingerprints, { TLS_KEY: fingerprintHash });
    await session.commitManagedConfigs!([first!]);
    const second = (await session.publishManagedConfigs!([{
      candidate: { name: "config", workspace, path: `${workspace}/candidate` },
      target: "/etc/demo/app.conf",
      mode: 0o600,
      owner: "root",
      group: "root",
      runAs: "deploy",
      secretRoot: "~/.sfo-deploy/secrets",
      secretFiles: ["TLS_KEY"],
    }]))[0];
    assertEquals(second!.changed, false);
    assertEquals(second!.serviceChange, false);
    assert(remoteCalls.some((call) => call.includes(".app.conf.sfo-secret-hashes.json")));
    await session.close();
  });
});
