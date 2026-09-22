import { assert, assertEquals, assertRejects, withTempDir } from "../_support/assert.ts";
import { resolved } from "../_support/fixtures.ts";
import { type CommandFactory, OpenSshTransport } from "../../src/transport.ts";
import { PreflightError, TransportError } from "../../src/errors.ts";

function output(code = 0, stdout = ""): Deno.CommandOutput {
  return {
    success: code === 0,
    code,
    signal: null,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
  };
}

for (const variant of ["traversal", "sibling", "resources-symlink", "release-symlink"] as const) {
  Deno.test(`integration/versioned-transport: ${variant} rejected before target mutation`, async () => {
    await withTempDir(async (root) => {
      const knownHosts = `${root}/known_hosts`;
      await Deno.writeTextFile(knownHosts, "fixture\n");
      const calls: string[] = [];
      const factory: CommandFactory = (_command, args) => {
        const remote = String(args.at(-1));
        calls.push(remote);
        let result = output();
        if (remote === "exec 'id' '-u'") result = output(0, "0\n");
        if (remote.includes("'stat' '-c' '%F'")) result = output(0, "regular file\n");
        if (remote.includes("'stat' '-c' '%s'")) result = output(0, "20\n");
        if (remote.includes("'stat' '-c' '%a'")) result = output(0, "600\n");
        if (remote.includes("'stat' '-c' '%U'")) result = output(0, "ubuntu\n");
        if (remote.includes("'stat' '-c' '%G'")) result = output(0, "ubuntu\n");
        if (remote.includes("'/usr/bin/test' '-L'")) {
          result = output(variant === "release-symlink" ? 0 : 1);
        }
        if (remote.includes("'realpath' '-e' '--' '/opt/demo/v2'")) {
          result = output(0, "/opt/demo/v2\n");
        }
        if (remote.includes("'realpath' '-e' '--' '/opt/demo/v2/resources'")) {
          result = output(
            0,
            variant === "resources-symlink" ? "/opt/outside\n" : "/opt/demo/v2/resources\n",
          );
        }
        return { output: () => Promise.resolve(result), kill: () => undefined };
      };
      const session = await new OpenSshTransport({ knownHosts, commandFactory: factory }).connect(
        resolved("node-a"),
      );
      try {
        const workspace = await session.createWorkspace();
        const target = variant === "traversal"
          ? "/opt/demo/v2/../v1/application.yml"
          : variant === "sibling"
          ? "/opt/demo/v20/application.yml"
          : "/opt/demo/v2/resources/application.yml";
        await assertRejects(
          () =>
            session.publishManagedConfigs!([{
              candidate: { name: "application", workspace, path: `${workspace}/candidate.yml` },
              target,
              releaseRoot: "/opt/demo/v2",
              mode: 0o600,
              secretRoot: "/opt/secrets",
              secretFiles: [],
            }]),
          variant === "sibling" ? PreflightError : TransportError,
          variant === "traversal"
            ? "Unsafe remote path"
            : variant === "sibling"
            ? "Version config target is out of bounds"
            : variant === "resources-symlink"
            ? "Version config parent directory escapes"
            : "Version root is not a regular directory",
        );
        if (variant === "traversal") {
          // safeRemotePath rejects the unnormalized target before any remote target probe.
          assert(!calls.some((call) => call.includes(target)));
        }
        assert(!calls.some((call) => call.includes("'install'") || call.includes("'mv'")));
      } finally {
        await session.close();
      }
    });
  });
}

Deno.test("integration/versioned-transport: preserveWorkspace retains recovery workspace but closes others", async () => {
  await withTempDir(async (root) => {
    const knownHosts = `${root}/known_hosts`;
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const calls: string[] = [];
    const session = await new OpenSshTransport({
      knownHosts,
      commandFactory: (_command, args) => {
        calls.push(String(args.at(-1)));
        return { output: () => Promise.resolve(output()), kill: () => undefined };
      },
    }).connect(resolved("node-a"));
    const retained = await session.createWorkspace();
    const cleaned = await session.createWorkspace();
    session.preserveWorkspace!(retained);
    await session.close();
    const removals = calls.filter((call) => call.includes("'rm' '-rf'"));
    assertEquals(removals.length, 1);
    assert(removals[0].includes(cleaned));
    assert(!removals[0].includes(retained));
  });
});

Deno.test("integration/versioned-transport: failed publish and restore return recoverable transaction", async () => {
  const { ManagedConfigPublicationError } = await import("../../src/remote_deployment.ts");
  await withTempDir(async (root) => {
    const knownHosts = `${root}/known_hosts`;
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const target = "/opt/demo/v2/resources/application.yml";
    const calls: string[] = [];
    const session = await new OpenSshTransport({
      knownHosts,
      commandFactory: (_command, args) => {
        const remote = String(args.at(-1));
        calls.push(remote);
        let result = output();
        if (remote === "exec 'id' '-u'") result = output(0, "0\n");
        if (remote.includes("'stat' '-c' '%F'")) result = output(0, "regular file\n");
        if (remote.includes("'stat' '-c' '%s'")) result = output(0, "20\n");
        if (remote.includes("'stat' '-c' '%a'")) result = output(0, "600\n");
        if (remote.includes("'stat' '-c' '%U'")) result = output(0, "ubuntu\n");
        if (remote.includes("'stat' '-c' '%G'")) result = output(0, "ubuntu\n");
        if (remote.includes("'/usr/bin/test' '-e'")) result = output(1);
        if (remote.includes("'mv' '-f' '-T'") || remote === `exec 'rm' '-f' '--' '${target}'`) {
          result = output(1);
        }
        return { output: () => Promise.resolve(result), kill: () => undefined };
      },
    }).connect(resolved("node-a"));
    try {
      const workspace = await session.createWorkspace();
      const failure = await assertRejects(() =>
        session.publishManagedConfigs!([{
          candidate: { name: "application", workspace, path: `${workspace}/candidate.yml` },
          target,
          mode: 0o600,
          secretRoot: "/opt/secrets",
          secretFiles: [],
        }]), ManagedConfigPublicationError);
      assertEquals(failure.recoveryFailed, true);
      assertEquals(failure.publications.length, 1);
      assertEquals(failure.publications[0].target, target);
      assertEquals(failure.publications[0].workspace, workspace);
      assertEquals(failure.publications[0].changed, true);
      assert(calls.some((call) => call === `exec 'rm' '-f' '--' '${target}'`));
      session.preserveWorkspace!(workspace);
    } finally {
      await session.close();
    }
  });
});

Deno.test("integration/versioned-transport: ordinary release resources accepts publication after boundary checks", async () => {
  await withTempDir(async (root) => {
    const knownHosts = `${root}/known_hosts`;
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const releaseRoot = "/opt/demo/v2";
    const parent = `${releaseRoot}/resources`;
    const target = `${parent}/application.yml`;
    const calls: string[] = [];
    const session = await new OpenSshTransport({
      knownHosts,
      commandFactory: (_command, args) => {
        const remote = String(args.at(-1));
        calls.push(remote);
        let result = output();
        if (remote === "exec 'id' '-u'") result = output(0, "0\n");
        if (remote.includes("'stat' '-c' '%F'")) result = output(0, "regular file\n");
        if (remote.includes("'stat' '-c' '%s'")) result = output(0, "20\n");
        if (remote.includes("'/usr/bin/test' '-e'") || remote.includes("'/usr/bin/test' '-L'")) {
          result = output(1);
        }
        if (remote === `exec 'realpath' '-e' '--' '${releaseRoot}'`) {
          result = output(0, `${releaseRoot}\n`);
        }
        if (remote === `exec 'realpath' '-e' '--' '${parent}'`) result = output(0, `${parent}\n`);
        return { output: () => Promise.resolve(result), kill: () => undefined };
      },
    }).connect(resolved("node-a"));
    try {
      const workspace = await session.createWorkspace();
      const publications = await session.publishManagedConfigs!([{
        candidate: { name: "application", workspace, path: `${workspace}/candidate.yml` },
        target,
        releaseRoot,
        mode: 0o600,
        secretRoot: "/opt/secrets",
        secretFiles: [],
      }]);
      assertEquals(publications.length, 1);
      assertEquals(publications[0].target, target);
      assertEquals(publications[0].changed, true);
      assertEquals(publications[0].existed, false);
      const rootCheck = calls.indexOf(`exec 'realpath' '-e' '--' '${releaseRoot}'`);
      const parentCheck = calls.indexOf(`exec 'realpath' '-e' '--' '${parent}'`);
      assert(!calls.some((call) => call.includes("'install' '-d'")));
      const install = calls.findIndex((call) => call.includes("'install' '-m' '0600'"));
      const rename = calls.findIndex((call) =>
        call.includes("'mv' '-f' '-T'") && call.endsWith(`'${target}'`)
      );
      assert(rootCheck >= 0 && parentCheck > rootCheck);
      assert(install > parentCheck && rename > install);
      assert(!calls.some((call) => call.includes("/latest")));
    } finally {
      await session.close();
    }
  });
});

Deno.test("integration/versioned-transport: missing release parent is created with app identity", async () => {
  await withTempDir(async (root) => {
    const knownHosts = `${root}/known_hosts`;
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const releaseRoot = "/opt/demo/v2";
    const parent = `${releaseRoot}/resources/config`;
    const target = `${parent}/application.yml`;
    const calls: string[] = [];
    const session = await new OpenSshTransport({
      knownHosts,
      commandFactory: (_command, args) => {
        const remote = String(args.at(-1));
        calls.push(remote);
        let result = output();
        if (remote === "exec 'id' '-u'") result = output(0, "0\n");
        if (remote.includes("'stat' '-c' '%F'")) result = output(0, "regular file\n");
        if (remote.includes("'stat' '-c' '%s'")) result = output(0, "20\n");
        if (remote.includes("'/usr/bin/test' '-L'")) result = output(1);
        if (remote === `exec '/usr/bin/test' '-d' '${parent}'`) result = output(1);
        if (
          remote === `exec '/usr/bin/test' '-e' '${releaseRoot}/resources'` ||
          remote === `exec '/usr/bin/test' '-e' '${parent}'` ||
          remote === `exec '/usr/bin/test' '-e' '${target}'`
        ) {
          result = output(1);
        }
        if (remote === `exec 'realpath' '-e' '--' '${releaseRoot}'`) {
          result = output(0, `${releaseRoot}\n`);
        }
        if (remote === `exec 'realpath' '-e' '--' '${parent}'`) {
          result = output(0, `${parent}\n`);
        }
        return { output: () => Promise.resolve(result), kill: () => undefined };
      },
    }).connect(resolved("node-a"));
    try {
      const workspace = await session.createWorkspace();
      const publications = await session.publishManagedConfigs!([{
        candidate: { name: "application", workspace, path: `${workspace}/candidate.yml` },
        target,
        releaseRoot,
        mode: 0o600,
        secretRoot: "/opt/secrets",
        secretFiles: [],
      }]);
      assertEquals(publications.length, 1);
      assertEquals(publications[0].target, target);
      assertEquals(publications[0].existed, false);
      const rootCheck = calls.indexOf(`exec 'realpath' '-e' '--' '${releaseRoot}'`);
      const createResources = calls.indexOf(
        `exec '/usr/bin/install' '-d' '-m' '0750' '-o' 'deploy' '--' '${releaseRoot}/resources'`,
      );
      const createConfig = calls.indexOf(
        `exec '/usr/bin/install' '-d' '-m' '0750' '-o' 'deploy' '--' '${parent}'`,
      );
      const parentCheck = calls.indexOf(`exec 'realpath' '-e' '--' '${parent}'`);
      const install = calls.findIndex((call) => call.includes("'install' '-m' '0600'"));
      assert(rootCheck >= 0);
      assert(createResources > rootCheck);
      assert(createConfig > createResources);
      assert(parentCheck > createConfig);
      assert(install > parentCheck);
    } finally {
      await session.close();
    }
  });
});

Deno.test("integration/versioned-transport: missing release parent creates directories for the SSH identity", async () => {
  await withTempDir(async (root) => {
    const knownHosts = `${root}/known_hosts`;
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const releaseRoot = "/opt/demo/v2";
    const parent = `${releaseRoot}/resources`;
    const target = `${parent}/application.yml`;
    const calls: string[] = [];
    const session = await new OpenSshTransport({
      knownHosts,
      commandFactory: (_command, args) => {
        const remote = String(args.at(-1));
        calls.push(remote);
        let result = output();
        if (remote === "exec 'id' '-u'") result = output(0, "0\n");
        if (remote.includes("'stat' '-c' '%F'")) result = output(0, "regular file\n");
        if (remote.includes("'stat' '-c' '%s'")) result = output(0, "20\n");
        if (remote.includes("'/usr/bin/test' '-L'")) result = output(1);
        if (remote === `exec '/usr/bin/test' '-d' '${parent}'`) result = output(1);
        if (
          remote === `exec '/usr/bin/test' '-e' '${parent}'` ||
          remote === `exec '/usr/bin/test' '-e' '${target}'`
        ) {
          result = output(1);
        }
        if (remote === `exec 'realpath' '-e' '--' '${releaseRoot}'`) {
          result = output(0, `${releaseRoot}\n`);
        }
        if (remote === `exec 'realpath' '-e' '--' '${parent}'`) {
          result = output(0, `${parent}\n`);
        }
        return { output: () => Promise.resolve(result), kill: () => undefined };
      },
    }).connect(resolved("node-a"));
    try {
      const workspace = await session.createWorkspace();
      const publications = await session.publishManagedConfigs!([{
        candidate: { name: "application", workspace, path: `${workspace}/candidate.yml` },
        target,
        releaseRoot,
        mode: 0o600,
        secretRoot: "/opt/secrets",
        secretFiles: [],
      }]);
      assertEquals(publications.length, 1);
      assert(calls.includes(
        `exec '/usr/bin/install' '-d' '-m' '0750' '-o' 'deploy' '--' '${parent}'`,
      ));
    } finally {
      await session.close();
    }
  });
});

Deno.test("integration/versioned-transport: missing release parent rejects intermediate symlink", async () => {
  await withTempDir(async (root) => {
    const knownHosts = `${root}/known_hosts`;
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const releaseRoot = "/opt/demo/v2";
    const parent = `${releaseRoot}/resources/config`;
    const target = `${parent}/application.yml`;
    const calls: string[] = [];
    const session = await new OpenSshTransport({
      knownHosts,
      commandFactory: (_command, args) => {
        const remote = String(args.at(-1));
        calls.push(remote);
        let result = output();
        if (remote === "exec 'id' '-u'") result = output(0, "0\n");
        if (remote.includes("'stat' '-c' '%F'")) result = output(0, "regular file\n");
        if (remote.includes("'stat' '-c' '%s'")) result = output(0, "20\n");
        if (remote.includes("'/usr/bin/test' '-L'")) {
          result = output(remote.includes(`/opt/demo/v2/resources`) ? 0 : 1);
        }
        if (remote === `exec '/usr/bin/test' '-d' '${parent}'`) result = output(1);
        if (remote === `exec '/usr/bin/test' '-e' '${releaseRoot}/resources'`) {
          result = output(0);
        }
        if (remote === `exec 'realpath' '-e' '--' '${releaseRoot}'`) {
          result = output(0, `${releaseRoot}\n`);
        }
        return { output: () => Promise.resolve(result), kill: () => undefined };
      },
    }).connect(resolved("node-a"));
    try {
      const workspace = await session.createWorkspace();
      await assertRejects(
        () =>
          session.publishManagedConfigs!([{
            candidate: { name: "application", workspace, path: `${workspace}/candidate.yml` },
            target,
            releaseRoot,
            mode: 0o600,
            secretRoot: "/opt/secrets",
            secretFiles: [],
          }]),
        TransportError,
        "Version config parent directory is not a regular directory",
      );
      assert(!calls.some((call) => call.includes("'install' '-m'")));
    } finally {
      await session.close();
    }
  });
});

Deno.test("integration/versioned-transport: GNU test probes avoid unsupported end-of-options marker", async () => {
  await withTempDir(async (root) => {
    const knownHosts = `${root}/known_hosts`;
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const releaseRoot = "/opt/demo/v2";
    const parent = `${releaseRoot}/resources`;
    const target = `${parent}/application.yml`;
    const calls: string[] = [];
    const session = await new OpenSshTransport({
      knownHosts,
      commandFactory: (_command, args) => {
        const remote = String(args.at(-1));
        calls.push(remote);
        // Ubuntu 24.04 的 GNU test 不支持 `--`：该 argv 会以退出码 2 和用法错误失败。
        if (remote.includes("/usr/bin/test") && remote.includes("'--'")) {
          return { output: () => Promise.resolve(output(2)), kill: () => undefined };
        }
        let result = output();
        if (remote === "exec 'id' '-u'") result = output(0, "0\n");
        if (remote.includes("'stat' '-c' '%F'")) result = output(0, "regular file\n");
        if (remote.includes("'stat' '-c' '%s'")) result = output(0, "20\n");
        if (remote.includes("'/usr/bin/test' '-L'")) result = output(1);
        if (remote === `exec '/usr/bin/test' '-d' '${parent}'`) result = output(1);
        if (remote === `exec '/usr/bin/test' '-e' '${parent}'`) result = output(1);
        if (remote === `exec '/usr/bin/test' '-e' '${target}'`) result = output(1);
        if (remote === `exec 'realpath' '-e' '--' '${releaseRoot}'`) {
          result = output(0, `${releaseRoot}\n`);
        }
        if (remote === `exec 'realpath' '-e' '--' '${parent}'`) {
          result = output(0, `${parent}\n`);
        }
        return { output: () => Promise.resolve(result), kill: () => undefined };
      },
    }).connect(resolved("node-a"));
    try {
      const workspace = await session.createWorkspace();
      const publications = await session.publishManagedConfigs!([{
        candidate: { name: "application", workspace, path: `${workspace}/candidate.yml` },
        target,
        releaseRoot,
        mode: 0o600,
        secretRoot: "/opt/secrets",
        secretFiles: [],
      }]);
      assertEquals(publications.length, 1);
      assertEquals(publications[0].target, target);
      assert(calls.includes(`exec '/usr/bin/test' '-d' '${parent}'`));
      assert(calls.includes(`exec '/usr/bin/test' '-e' '${parent}'`));
      assert(!calls.some((call) => call.includes("/usr/bin/test") && call.includes("'--'")));
    } finally {
      await session.close();
    }
  });
});
