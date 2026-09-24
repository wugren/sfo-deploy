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

async function disableDeno(cluster: string, machine = "node-a"): Promise<void> {
  const path = `${cluster}/machines.yaml`;
  const original = await Deno.readTextFile(path);
  if (machine === "node-a") {
    await Deno.writeTextFile(
      path,
      original.replace(
        "    deno: /usr/bin/deno\n",
        "    deno: /usr/bin/deno\n    enable_deno: false\n",
      ),
    );
    return;
  }
  await Deno.writeTextFile(
    path,
    `${original}  - name: ${machine}\n    private_ip: 10.0.0.3\n    public_ip: 203.0.113.11\n    region: local\n    ssh_user: deploy\n    deno: /usr/bin/deno\n    enable_deno: false\n`,
  );
}

Deno.test("dv/install-deno: disabled selected machine is logged and never connected", async () => {
  await withTempDir(async (root) => {
    const cluster = await writeCluster(root);
    await disableDeno(cluster);
    const transport = new FakeTransport();
    const events: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const result = await run(
      { configRoot: root, cluster: "demo", action: "install-deno", machines: ["node-a"] },
      {
        transport,
        onInfo: (message, fields) => {
          events.push({ message, fields });
        },
      },
    );
    assert(result instanceof InstallDenoResult);
    assertEquals(result.exitCode, 0);
    assertEquals(result.machines, []);
    assertEquals(transport.connectCalls, 0);
    assertEquals(events.find((event) => event.message === "Deno machine skipped")?.fields, {
      machine: "node-a",
      reason: "enable_deno: false",
    });
  });
});

Deno.test("dv/install-deno: mixed default selection confirms and reports only enabled machines", async () => {
  await withTempDir(async (root) => {
    const cluster = await writeCluster(root);
    await disableDeno(cluster, "node-b");
    const transport = new FakeTransport(() => new FakeSession(0, "deno 2.7.8\n"));
    let confirmed: readonly string[] | undefined;
    const progress: Array<{ index: number; total: number; machine: string }> = [];
    const result = await run(
      { configRoot: root, cluster: "demo", action: "install-deno", denoVersion: "2.7.8" },
      {
        transport,
        confirmMachines: (machines) => {
          confirmed = machines;
          return true;
        },
        onProgress: (event) => {
          if (event.kind === "machine-result") {
            progress.push({
              index: event.index,
              total: event.total,
              machine: event.machine.machine,
            });
          }
        },
      },
    );
    assert(result instanceof InstallDenoResult);
    assertEquals(confirmed, ["node-a"]);
    assertEquals(progress, [{ index: 0, total: 1, machine: "node-a" }]);
    assertEquals(result.machines.map((machine) => machine.machine), ["node-a"]);
    assertEquals(transport.connectCalls, 1);
  });
});

Deno.test("dv/install-deno: all disabled skips confirmation and unknown machine still fails", async () => {
  await withTempDir(async (root) => {
    const cluster = await writeCluster(root);
    await disableDeno(cluster);
    const transport = new FakeTransport();
    let confirmations = 0;
    const result = await run(
      { configRoot: root, cluster: "demo", action: "install-deno" },
      {
        transport,
        confirmMachines: () => {
          confirmations++;
          return true;
        },
      },
    );
    assert(result instanceof InstallDenoResult);
    assertEquals(result.machines, []);
    assertEquals(confirmations, 0);
    assertEquals(transport.connectCalls, 0);

    const unknown = await run(
      { configRoot: root, cluster: "demo", action: "install-deno", machines: ["node-missing"] },
      { transport },
    );
    assert(unknown instanceof InstallDenoResult);
    assertEquals(unknown.machines[0].status, "failed");
    assertStringIncludes(unknown.machines[0].message ?? "", "Unknown machine: node-missing");
    assertEquals(transport.connectCalls, 0);
  });
});

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
