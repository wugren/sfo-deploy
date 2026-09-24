import { join } from "jsr:@std/path@1.1.6";
import { assert, assertEquals, assertStringIncludes, withTempDir } from "../_support/assert.ts";
import {
  CLI_ACTIONS,
  ConfigurationError,
  createCli,
  loadCluster,
  RunOptions,
  type Transport,
} from "../../src/mod.ts";

Deno.test("integration/package: public module exposes new TypeScript consumer path", () => {
  assert(CLI_ACTIONS.includes("deploy"));
  assert(CLI_ACTIONS.includes("fetch"));
  assert(!(CLI_ACTIONS as readonly string[]).includes("install"));
  assert(!(CLI_ACTIONS as readonly string[]).includes("configure"));
  assertEquals(typeof createCli, "function");
  assertEquals(typeof loadCluster, "function");
  const transport: Transport | undefined = undefined;
  assertEquals(transport, undefined);
  const options = new RunOptions({ configRoot: "/tmp", cluster: "demo", action: "validate" });
  assertEquals(options.cluster, "demo");
  try {
    new RunOptions({ configRoot: "/tmp", cluster: "../bad", action: "validate" });
    throw new Error("expected ConfigurationError");
  } catch (error) {
    assert(error instanceof ConfigurationError);
  }
});

Deno.test({
  name:
    "integration/install: isolated Deno global install runs sfo-deploy from PATH and uninstalls",
  fn: async () => {
    await withTempDir(async (root) => {
      const installRoot = join(root, "install");
      const cache = join(root, "deno-dir");
      const env = { ...Deno.env.toObject(), DENO_INSTALL_ROOT: installRoot, DENO_DIR: cache };
      const install = await new Deno.Command(Deno.execPath(), {
        args: [
          "install",
          "--global",
          "--force",
          "--name",
          "sfo-deploy",
          "--allow-read",
          "--allow-write",
          "--allow-env",
          "--allow-net",
          "--allow-run=ssh,scp,filehub,ps",
          "./src/main.ts",
        ],
        cwd: Deno.cwd(),
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(install.code, 0, new TextDecoder().decode(install.stderr));
      const executable = join(
        installRoot,
        "bin",
        Deno.build.os === "windows" ? "sfo-deploy.cmd" : "sfo-deploy",
      );
      const help = await new Deno.Command(executable, {
        args: ["--help"],
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(help.code, 0, new TextDecoder().decode(help.stderr));
      assertStringIncludes(new TextDecoder().decode(help.stdout), "sfo-deploy");
      const uninstall = await new Deno.Command(Deno.execPath(), {
        args: ["uninstall", "--global", "--root", installRoot, "sfo-deploy"],
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(uninstall.code, 0, new TextDecoder().decode(uninstall.stderr));
      try {
        await Deno.stat(executable);
        throw new Error("uninstall left executable behind");
      } catch (error) {
        assert(error instanceof Deno.errors.NotFound);
      }
    });
  },
});
