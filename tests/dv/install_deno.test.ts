import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { FakeSession, FakeTransport } from "../_support/fake_session.ts";
import { writeCluster } from "../_support/fixtures.ts";
import { CancelledError, PreflightError } from "../../src/errors.ts";
import { InstallDenoResult, run } from "../../src/mod.ts";

Deno.test("dv/install-deno: main flow installs on generated cluster and closes session", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    const machinesBefore = await Deno.readTextFile(`${root}/demo/machines.yaml`);
    const session = new FakeSession(127, "", 0, 0, "deno 2.7.8\n");
    const transport = new FakeTransport(() => session);
    const result = await run(
      {
        configRoot: root,
        cluster: "demo",
        action: "install-deno",
        machines: ["node-a"],
      },
      { transport },
    );
    assert(result instanceof InstallDenoResult);
    assertEquals(result.exitCode, 0);
    assertEquals(result.machines.length, 1);
    assertEquals(result.machines[0].status, "installed");
    assertEquals(result.machines[0].version, "2.7.8");
    assertEquals(result.machines[0].denoPath, "/usr/local/bin/deno");
    assert(session.closed);
    assertEquals(transport.connectCalls, 1);
    assertEquals(await Deno.readTextFile(`${root}/demo/machines.yaml`), machinesBefore);
  });
});

Deno.test("dv/install-deno: lifecycle config variant installs to privileged root", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    const session = new FakeSession(127, "", 0, 0, "deno 2.7.8\n");
    const transport = new FakeTransport(() => session);
    const result = await run(
      {
        configRoot: root,
        cluster: "demo",
        action: "install-deno",
        machines: ["node-a"],
        installTo: "/usr/local",
      },
      { transport },
    );
    assert(result instanceof InstallDenoResult);
    assertEquals(result.machines[0].denoPath, "/usr/local/bin/deno");
    const installer = session.calls.find((call) =>
      call.argv[0] === "/bin/sh" &&
      String(call.argv[2] ?? "").includes("github.com/denoland/deno/releases/")
    );
    assertEquals(installer?.options.privileged, true);
    assertEquals(installer?.options.environment, { DENO_INSTALL: "/usr/local" });
  });
});

Deno.test("dv/install-deno: explicit satisfied version skips install", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    const session = new FakeSession(0, "deno 2.7.8\n");
    const transport = new FakeTransport(() => session);
    const result = await run(
      {
        configRoot: root,
        cluster: "demo",
        action: "install-deno",
        machines: ["node-a"],
        denoVersion: "2.7.8",
      },
      { transport },
    );
    assert(result instanceof InstallDenoResult);
    assertEquals(result.machines[0].status, "present");
    assertEquals(result.machines[0].version, "2.7.8");
    assertEquals(session.installCalls, 0);
  });
});

Deno.test("dv/install-deno: latest default verifies and skips when already latest", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    const session = new FakeSession(0, "deno 2.7.8\n", 0, 0, "deno 2.7.8\n");
    session.downloadedVersion = "2.7.8";
    const transport = new FakeTransport(() => session);
    const result = await run(
      {
        configRoot: root,
        cluster: "demo",
        action: "install-deno",
        machines: ["node-a"],
      },
      { transport },
    );
    assert(result instanceof InstallDenoResult);
    assertEquals(result.machines[0].status, "present");
    assertEquals(result.machines[0].version, "2.7.8");
    assertEquals(session.installCalls, 1);
    assertEquals(session.checksumChecked, true);
    assertEquals(session.installSkipped, true);
  });
});

Deno.test("dv/install-deno: failure workflow fails closed and still closes session", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    const session = new FakeSession(127, "", 9, 0, "deno 2.7.8\n");
    const transport = new FakeTransport(() => session);
    const result = await run(
      {
        configRoot: root,
        cluster: "demo",
        action: "install-deno",
        machines: ["node-a"],
      },
      { transport },
    );
    assert(result instanceof InstallDenoResult);
    assertEquals(result.exitCode, 4);
    assertEquals(result.machines[0].status, "failed");
    assertEquals(result.machines[0].errorCategory, "transport");
    assert(session.closed);
  });
});

Deno.test("dv/install-deno: preflight failure maps to documented exit code 3", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    const transport = new FakeTransport(
      () => new FakeSession(127, "", 0, 0, "deno 2.7.8\n"),
      new PreflightError("known_hosts unavailable"),
    );
    const result = await run(
      {
        configRoot: root,
        cluster: "demo",
        action: "install-deno",
        machines: ["node-a"],
      },
      { transport },
    );
    assert(result instanceof InstallDenoResult);
    assertEquals(result.exitCode, 3);
    assertEquals(result.machines[0].status, "failed");
    assertEquals(result.machines[0].errorCategory, "preflight");
  });
});

Deno.test("dv/install-deno: default all machines respects confirmation gate", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    const transport = new FakeTransport();
    await assertRejects(
      () =>
        run(
          { configRoot: root, cluster: "demo", action: "install-deno" },
          { transport, confirmMachines: () => Promise.resolve(false) },
        ),
      CancelledError,
      "Cancelled",
    );
    assertEquals(transport.connectCalls, 0);
  });
});

Deno.test("dv/install-deno: missing tools are auto-installed through apt before deno", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    const machinesBefore = await Deno.readTextFile(`${root}/demo/machines.yaml`);
    const session = new FakeSession(127, "", 0, 0, "deno 2.7.8\n", "/home/deploy", []);
    const transport = new FakeTransport(() => session);
    const result = await run(
      {
        configRoot: root,
        cluster: "demo",
        action: "install-deno",
        machines: ["node-a"],
      },
      { transport },
    );
    assert(result instanceof InstallDenoResult);
    assertEquals(result.exitCode, 0);
    assertEquals(result.machines[0].status, "installed");
    assertEquals(result.machines[0].version, "2.7.8");
    assertEquals(session.pmCalls.length, 2);
    assert(session.pmCalls.every((call) => call.options.privileged === true));
    assert(session.closed);
    assertEquals(await Deno.readTextFile(`${root}/demo/machines.yaml`), machinesBefore);
  });
});

Deno.test("dv/install-deno: unsupported package manager maps to transport failure exit 4", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    const session = new FakeSession(127, "", 0, 0, "deno 2.7.8\n", "/home/deploy", [], "");
    const transport = new FakeTransport(() => session);
    const result = await run(
      {
        configRoot: root,
        cluster: "demo",
        action: "install-deno",
        machines: ["node-a"],
      },
      { transport },
    );
    assert(result instanceof InstallDenoResult);
    assertEquals(result.exitCode, 4);
    assertEquals(result.machines[0].status, "failed");
    assertEquals(result.machines[0].errorCategory, "transport");
    assertStringIncludes(String(result.machines[0].message), "has no usable package manager");
    assert(session.closed);
  });
});

Deno.test("dv/install-deno: privilege failure while ensuring tools maps to preflight exit 3", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    const session = new FakeSession(
      127,
      "",
      0,
      0,
      "deno 2.7.8\n",
      "/home/deploy",
      [],
      "/usr/bin/apt-get",
      0,
      0,
      true,
      new PreflightError("Remote identity is neither root nor able to use non-interactive sudo"),
    );
    const transport = new FakeTransport(() => session);
    const result = await run(
      {
        configRoot: root,
        cluster: "demo",
        action: "install-deno",
        machines: ["node-a"],
      },
      { transport },
    );
    assert(result instanceof InstallDenoResult);
    assertEquals(result.exitCode, 3);
    assertEquals(result.machines[0].status, "failed");
    assertEquals(result.machines[0].errorCategory, "preflight");
    assert(session.closed);
  });
});
