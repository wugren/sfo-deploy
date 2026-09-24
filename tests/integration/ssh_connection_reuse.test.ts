import { join } from "jsr:@std/path@1.1.6";
import { assert, assertEquals, withTempDir } from "../_support/assert.ts";
import { resolved } from "../_support/fixtures.ts";
import { OpenSshTransport, type SpawnedCommand } from "../../src/transport.ts";

const available = Deno.build.os === "linux" &&
  await Deno.stat("/usr/sbin/sshd").then(() => true, () => false) &&
  await Deno.stat("/usr/lib/openssh/sftp-server").then(() => true, () => false) &&
  await Deno.stat("/run/sshd").then(() => true, () => false) &&
  new TextDecoder().decode((await run("id", ["-u"])).stdout).trim() === "0";

async function run(command: string, args: string[]): Promise<Deno.CommandOutput> {
  return await new Deno.Command(command, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
}

Deno.test({
  name: "integration/transport: commands and scp share one real SSH connection",
  ignore: !available,
  fn: async () => {
    await withTempDir(async (root) => {
      const hostKey = join(root, "host_key");
      const userKey = join(root, "user_key");
      const authorizedKeys = join(root, "authorized_keys");
      const knownHosts = join(root, "known_hosts");
      const config = join(root, "sshd_config");
      const log = join(root, "sshd.log");
      const source = join(root, "source.txt");
      const target = join(root, "target.txt");
      for (const key of [hostKey, userKey]) {
        const generated = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
        assertEquals(generated.code, 0);
      }
      const publicKey = (await Deno.readTextFile(`${userKey}.pub`)).trim();
      const hostPublic = (await Deno.readTextFile(`${hostKey}.pub`)).trim().split(" ").slice(0, 2)
        .join(" ");
      await Deno.writeTextFile(authorizedKeys, `${publicKey}\n`);
      await Deno.writeTextFile(source, "one connection\n");
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const port = (listener.addr as Deno.NetAddr).port;
      listener.close();
      await Deno.writeTextFile(knownHosts, `[127.0.0.1]:${port} ${hostPublic}\n`);
      await Deno.writeTextFile(
        config,
        [
          `Port ${port}`,
          "ListenAddress 127.0.0.1",
          `HostKey ${hostKey}`,
          `AuthorizedKeysFile ${authorizedKeys}`,
          "PermitRootLogin yes",
          "StrictModes no",
          "PasswordAuthentication no",
          "KbdInteractiveAuthentication no",
          "UsePAM no",
          "Subsystem sftp /usr/lib/openssh/sftp-server",
          "LogLevel VERBOSE",
        ].join("\n") + "\n",
      );
      const server = new Deno.Command("/usr/sbin/sshd", {
        args: ["-D", "-e", "-E", log, "-f", config],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      let session: Awaited<ReturnType<OpenSshTransport["connect"]>> | undefined;
      try {
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            const probe = await Deno.connect({ hostname: "127.0.0.1", port });
            probe.close();
            ready = true;
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        assert(ready, "temporary sshd did not start");
        let baseline = 0;
        for (let attempt = 0; attempt < 100; attempt++) {
          baseline = (await Deno.readTextFile(log)).match(/Connection from 127\.0\.0\.1/g)
            ?.length ?? 0;
          if (baseline > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert(baseline > 0, "temporary sshd did not record the readiness probe");
        let controlPath = "";
        const transport = new OpenSshTransport({
          knownHosts,
          commandFactory: (command, args): SpawnedCommand => {
            controlPath ||= args.find((arg) => arg.startsWith("ControlPath="))?.slice(12) ?? "";
            return new Deno.Command(command, {
              args: [...args],
              stdin: "null",
              stdout: "piped",
              stderr: "piped",
            }).spawn();
          },
        });
        const targetMachine = resolved("local", "127.0.0.1");
        session = await transport.connect({
          ...targetMachine,
          machine: {
            ...targetMachine.machine,
            sshUser: "root",
            sshPort: port,
            sshPrivateKey: userKey,
          },
        });
        assertEquals((await session.run(["printf", "first"])).stdout, "first");
        await session.uploadFile(source, target);
        assertEquals((await session.run(["cat", target])).stdout, "one connection\n");
        const check = await run("ssh", [
          "-S",
          controlPath,
          "-O",
          "check",
          "-p",
          String(port),
          "root@127.0.0.1",
        ]);
        assertEquals(check.code, 0);
        const count = (await Deno.readTextFile(log)).match(/Connection from 127\.0\.0\.1/g)
          ?.length ?? 0;
        assertEquals(count - baseline, 1);
        await session.close();
        session = undefined;
        await Deno.stat(controlPath).then(
          () => {
            throw new Error("SSH control socket remained after close");
          },
          (error) => {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          },
        );
      } finally {
        await session?.close().catch(() => undefined);
        try {
          server.kill();
        } catch { /* The temporary server may have exited already. */ }
        await server.output();
      }
    });
  },
});
