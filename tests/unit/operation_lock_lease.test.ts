import { join } from "jsr:@std/path@1.1.6";
import { assert, assertEquals, assertRejects, withTempDir } from "../_support/assert.ts";
import { resolved } from "../_support/fixtures.ts";
import { type CommandFactory, OpenSshTransport, type SpawnedCommand } from "../../src/transport.ts";
import { TransportError } from "../../src/errors.ts";

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

Deno.test("unit/operation-lock-lease: acquire 传入 leaseTtlMs 时 holder 携带 lease 路径与 TTL，release 清理 lease 文件", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    let resolveHolder!: (value: Deno.CommandOutput) => void;
    let killed = false;
    const holder = new Promise<Deno.CommandOutput>((resolve) => resolveHolder = resolve);
    const calls: string[] = [];
    const factory: CommandFactory = (_command, args) => {
      const remote = String(args.at(-1) ?? "");
      calls.push(remote);
      if (remote.includes("exec 'flock'")) {
        return {
          output: () => holder,
          kill: () => {
            killed = true;
            resolveHolder(output(143));
          },
        };
      }
      if (remote.includes("'/usr/bin/test' '-f'") && remote.includes("lock-ready-")) {
        return spawned(output());
      }
      if (remote.includes("'rm' '-f' '--'") && remote.includes("lock-stop-")) {
        queueMicrotask(() => resolveHolder(output()));
        return spawned(output());
      }
      return spawned(output());
    };
    const session = await new OpenSshTransport({
      knownHosts,
      commandFactory: factory,
      terminateTimeoutMs: 50,
    }).connect(resolved("node-a"));
    const lease = await session.acquireOperationLock!({
      app: "demo",
      target: "node-a",
      timeoutMs: 200,
      leaseTtlMs: 600_000,
    });
    const holderCall = calls.find((call) => call.includes("exec 'flock'"))!;
    assert(holderCall.includes("/tmp/sfo-deploy-lock-lease-"));
    assert(holderCall.includes("/usr/bin/stat"));
    assert(holderCall.includes("/usr/bin/date"));
    assert(holderCall.includes("'600'"));
    await session.releaseOperationLock!(lease);
    assertEquals(killed, false);
    assert(calls.some((call) => call.includes("'rm' '-f' '--'") && call.includes("lock-lease-")));
    await session.close();
  });
});

Deno.test("unit/operation-lock-lease: 非法 leaseTtlMs 在远端调用前被拒绝", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const factory: CommandFactory = (_command, args) => {
      const remote = String(args.at(-1) ?? "");
      if (remote === "exec 'true'") return spawned(output());
      return spawned(output());
    };
    const session = await new OpenSshTransport({ knownHosts, commandFactory: factory })
      .connect(resolved("node-a"));
    await assertRejects(
      () =>
        session.acquireOperationLock!({
          app: "demo",
          target: "node-a",
          timeoutMs: 200,
          leaseTtlMs: 0,
        }),
      TypeError,
      "target operation lock lease TTL timeout must be a positive number",
    );
    await session.close();
  });
});

Deno.test("unit/operation-lock-lease: holder 因租约过期退出时 release 清理后抛出失锁错误", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    let resolveExpired!: (value: Deno.CommandOutput) => void;
    const expiredHolder = new Promise<Deno.CommandOutput>((resolve) => resolveExpired = resolve);
    let killed = false;
    const calls: string[] = [];
    const factory: CommandFactory = (_command, args) => {
      const remote = String(args.at(-1) ?? "");
      calls.push(remote);
      if (remote.includes("exec 'flock'")) {
        return {
          output: () => expiredHolder,
          kill: () => {
            killed = true;
            resolveExpired(output(143));
          },
        };
      }
      if (remote.includes("'/usr/bin/test' '-f'") && remote.includes("lock-ready-")) {
        return spawned(output());
      }
      return spawned(output());
    };
    const session = await new OpenSshTransport({
      knownHosts,
      commandFactory: factory,
      terminateTimeoutMs: 50,
    }).connect(resolved("node-a"));
    const lease = await session.acquireOperationLock!({
      app: "demo",
      target: "node-a",
      timeoutMs: 200,
      leaseTtlMs: 600_000,
    });
    resolveExpired(output(74));
    await assertRejects(
      () => session.releaseOperationLock!(lease),
      TransportError,
      "was lost",
    );
    assertEquals(killed, false);
    assert(calls.some((call) => call.includes("'rm' '-f' '--'") && call.includes("lock-lease-")));
    await session.close();
  });
});

Deno.test("unit/operation-lock-lease: holder 意外退出后受保护命令被拒绝，清理仍完成", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    let resolveHolder!: (value: Deno.CommandOutput) => void;
    const holder = new Promise<Deno.CommandOutput>((resolve) => resolveHolder = resolve);
    const calls: string[] = [];
    const factory: CommandFactory = (_command, args) => {
      const remote = String(args.at(-1) ?? "");
      calls.push(remote);
      if (remote.includes("exec 'flock'")) {
        return { output: () => holder, kill: () => resolveHolder(output(143)) };
      }
      if (remote.includes("'/usr/bin/test' '-f'") && remote.includes("lock-ready-")) {
        return spawned(output());
      }
      return spawned(output());
    };
    const session = await new OpenSshTransport({
      knownHosts,
      commandFactory: factory,
      terminateTimeoutMs: 50,
    }).connect(resolved("node-a"));
    const lease = await session.acquireOperationLock!({
      app: "demo",
      target: "node-a",
      timeoutMs: 200,
      leaseTtlMs: 600_000,
    });
    resolveHolder(output(74));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await assertRejects(
      () => session.run(["true"]),
      TransportError,
      "was lost",
    );
    await assertRejects(
      () => session.releaseOperationLock!(lease),
      TransportError,
      "was lost",
    );
    assert(calls.some((call) => call.includes("'rm' '-f' '--'") && call.includes("lock-lease-")));
    await session.close();
  });
});

Deno.test("unit/operation-lock-lease: 旧会话失锁后第二会话取得同一锁，旧会话写入与释放均失败", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    let resolveFirst!: (value: Deno.CommandOutput) => void;
    let resolveSecond!: (value: Deno.CommandOutput) => void;
    const firstHolder = new Promise<Deno.CommandOutput>((resolve) => resolveFirst = resolve);
    const secondHolder = new Promise<Deno.CommandOutput>((resolve) => resolveSecond = resolve);
    const stopResolvers = new Map<string, (value: Deno.CommandOutput) => void>();
    let holderCalls = 0;
    const calls: string[] = [];
    const stopPathOf = (remote: string): string =>
      remote.match(/sfo-deploy-lock-stop-[a-f0-9]+/)?.[0] ?? "";
    const factory: CommandFactory = (_command, args) => {
      const remote = String(args.at(-1) ?? "");
      calls.push(remote);
      if (remote.includes("exec 'flock'")) {
        holderCalls += 1;
        const first = holderCalls === 1;
        const stop = stopPathOf(remote);
        stopResolvers.set(stop, first ? resolveFirst : resolveSecond);
        return {
          output: () => first ? firstHolder : secondHolder,
          kill: () => stopResolvers.get(stop)?.(output(143)),
        };
      }
      if (remote.includes("'/usr/bin/test' '-f'") && remote.includes("lock-ready-")) {
        return spawned(output());
      }
      if (remote.includes("'rm' '-f' '--'") && remote.includes("lock-stop-")) {
        const resolve = stopResolvers.get(stopPathOf(remote));
        if (resolve) queueMicrotask(() => resolve(output()));
        return spawned(output());
      }
      return spawned(output());
    };
    const options = { knownHosts, commandFactory: factory, terminateTimeoutMs: 50 };
    const first = await new OpenSshTransport(options).connect(resolved("node-a"));
    const firstLease = await first.acquireOperationLock!({
      app: "demo",
      target: "node-a",
      timeoutMs: 200,
      leaseTtlMs: 600_000,
    });
    resolveFirst(output(74));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await new OpenSshTransport(options).connect(resolved("node-a"));
    const secondLease = await second.acquireOperationLock!({
      app: "demo",
      target: "node-a",
      timeoutMs: 200,
      leaseTtlMs: 600_000,
    });
    assertEquals(holderCalls, 2);
    assertEquals((await second.run(["true"])).exitCode, 0);
    await assertRejects(() => first.run(["true"]), TransportError, "was lost");
    await assertRejects(
      () => first.releaseOperationLock!(firstLease),
      TransportError,
      "was lost",
    );
    await second.releaseOperationLock!(secondLease);
    await first.close();
    await second.close();
  });
});

Deno.test("unit/operation-lock-lease: 失锁中止在途受保护命令，旧执行方不能继续写入", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    let resolveHolder!: (value: Deno.CommandOutput) => void;
    let resolveInFlight!: (value: Deno.CommandOutput) => void;
    const holder = new Promise<Deno.CommandOutput>((resolve) => resolveHolder = resolve);
    const inFlight = new Promise<Deno.CommandOutput>((resolve) => resolveInFlight = resolve);
    let killed = false;
    const factory: CommandFactory = (_command, args) => {
      const remote = String(args.at(-1) ?? "");
      if (remote.includes("exec 'flock'")) {
        return { output: () => holder, kill: () => resolveHolder(output(143)) };
      }
      if (remote.includes("'/usr/bin/test' '-f'") && remote.includes("lock-ready-")) {
        return spawned(output());
      }
      if (remote.includes("sleep 5")) {
        return {
          output: () => inFlight,
          kill: () => {
            killed = true;
            resolveInFlight(output(143));
          },
        };
      }
      return spawned(output());
    };
    const session = await new OpenSshTransport({
      knownHosts,
      commandFactory: factory,
      terminateTimeoutMs: 50,
    }).connect(resolved("node-a"));
    const lease = await session.acquireOperationLock!({
      app: "demo",
      target: "node-a",
      timeoutMs: 200,
      leaseTtlMs: 600_000,
    });
    const running = session.run(["/bin/sh", "-c", "sleep 5"]);
    resolveHolder(output(74));
    await assertRejects(() => running, TransportError, "was lost");
    assertEquals(killed, true);
    await assertRejects(
      () => session.releaseOperationLock!(lease),
      TransportError,
      "was lost",
    );
    await session.close();
  });
});

Deno.test("unit/operation-lock-lease: 失锁终止被跟踪进程的整棵后代进程树", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const marker = join(root, "descendant-marker");
    let resolveHolder!: (value: Deno.CommandOutput) => void;
    const holder = new Promise<Deno.CommandOutput>((resolve) => resolveHolder = resolve);
    const factory: CommandFactory = (_command, args) => {
      const remote = String(args.at(-1) ?? "");
      if (remote.includes("exec 'flock'")) {
        return { output: () => holder, kill: () => resolveHolder(output(143)) };
      }
      if (remote.includes("descendant-marker")) {
        return new Deno.Command("/bin/sh", {
          args: ["-c", remote],
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
      }
      return spawned(output());
    };
    const session = await new OpenSshTransport({
      knownHosts,
      commandFactory: factory,
      terminateTimeoutMs: 100,
    }).connect(resolved("node-a"));
    const lease = await session.acquireOperationLock!({
      app: "demo",
      target: "node-a",
      timeoutMs: 200,
      leaseTtlMs: 600_000,
    });
    const script = `sh -c 'sleep 1; printf old > ${marker}' & wait`;
    const running = session.run(["/bin/sh", "-c", script]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    resolveHolder(output(74));
    await assertRejects(() => running, TransportError, "was lost");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assertEquals(await Deno.stat(marker).then(() => true, () => false), false);
    await assertRejects(
      () => session.releaseOperationLock!(lease),
      TransportError,
      "was lost",
    );
    await session.close();
  });
});

Deno.test("unit/operation-lock-lease: 失锁升级 SIGKILL 终止忽略 SIGTERM 的后代进程", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const marker = join(root, "descendant-marker");
    let resolveHolder!: (value: Deno.CommandOutput) => void;
    const holder = new Promise<Deno.CommandOutput>((resolve) => resolveHolder = resolve);
    const factory: CommandFactory = (_command, args) => {
      const remote = String(args.at(-1) ?? "");
      if (remote.includes("exec 'flock'")) {
        return { output: () => holder, kill: () => resolveHolder(output(143)) };
      }
      if (remote.includes("descendant-marker")) {
        return new Deno.Command("/bin/sh", {
          args: ["-c", remote],
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
      }
      return spawned(output());
    };
    const session = await new OpenSshTransport({
      knownHosts,
      commandFactory: factory,
      terminateTimeoutMs: 100,
    }).connect(resolved("node-a"));
    const lease = await session.acquireOperationLock!({
      app: "demo",
      target: "node-a",
      timeoutMs: 200,
      leaseTtlMs: 600_000,
    });
    const script =
      `sh -c 'trap "" TERM; exec >/dev/null 2>&1; sleep 1; printf old > ${marker}' & exec sleep 5`;
    const running = session.run(["/bin/sh", "-c", script]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assertEquals(
      await Deno.stat(marker).then(() => true, () => false),
      false,
      "后代在失锁时仍应存活且尚未写出标记",
    );
    resolveHolder(output(74));
    await assertRejects(() => running, TransportError, "was lost");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assertEquals(await Deno.stat(marker).then(() => true, () => false), false);
    await assertRejects(
      () => session.releaseOperationLock!(lease),
      TransportError,
      "was lost",
    );
    await session.close();
  });
});

Deno.test("unit/operation-lock-lease: 失锁后 uploadFile 在发起 SCP 前失败", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const source = join(root, "source");
    await Deno.writeTextFile(source, "payload");
    let resolveHolder!: (value: Deno.CommandOutput) => void;
    const holder = new Promise<Deno.CommandOutput>((resolve) => resolveHolder = resolve);
    let scpCalls = 0;
    const factory: CommandFactory = (command, args) => {
      const remote = String(args.at(-1) ?? "");
      if (command === "scp") {
        scpCalls += 1;
        return spawned(output());
      }
      if (remote.includes("exec 'flock'")) {
        return { output: () => holder, kill: () => resolveHolder(output(143)) };
      }
      if (remote.includes("'/usr/bin/test' '-f'") && remote.includes("lock-ready-")) {
        return spawned(output());
      }
      return spawned(output());
    };
    const session = await new OpenSshTransport({
      knownHosts,
      commandFactory: factory,
      terminateTimeoutMs: 50,
    }).connect(resolved("node-a"));
    const lease = await session.acquireOperationLock!({
      app: "demo",
      target: "node-a",
      timeoutMs: 200,
      leaseTtlMs: 600_000,
    });
    resolveHolder(output(74));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await assertRejects(
      () => session.uploadFile(source, `${root}/upload-after-loss`),
      TransportError,
      "was lost",
    );
    assertEquals(scpCalls, 0);
    await assertRejects(
      () => session.releaseOperationLock!(lease),
      TransportError,
      "was lost",
    );
    await session.close();
  });
});

Deno.test("unit/operation-lock-lease: 释放通知失败仍终止回收 holder 并移除跟踪", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    let resolveHolder!: (value: Deno.CommandOutput) => void;
    const holder = new Promise<Deno.CommandOutput>((resolve) => resolveHolder = resolve);
    let killed = false;
    const calls: string[] = [];
    const factory: CommandFactory = (_command, args) => {
      const remote = String(args.at(-1) ?? "");
      calls.push(remote);
      if (remote.includes("exec 'flock'")) {
        return {
          output: () => holder,
          kill: () => {
            killed = true;
            resolveHolder(output(143));
          },
        };
      }
      if (remote.includes("'/usr/bin/test' '-f'") && remote.includes("lock-ready-")) {
        return spawned(output());
      }
      if (
        remote.includes("'rm' '-f' '--'") && remote.includes("lock-stop-") &&
        !remote.includes("lock-ready-")
      ) {
        return spawned(output(255, "", "release notification failed"));
      }
      return spawned(output());
    };
    const session = await new OpenSshTransport({
      knownHosts,
      commandFactory: factory,
      terminateTimeoutMs: 50,
    }).connect(resolved("node-a"));
    const lease = await session.acquireOperationLock!({
      app: "demo",
      target: "node-a",
      timeoutMs: 200,
      leaseTtlMs: 600_000,
    });
    await assertRejects(
      () => session.releaseOperationLock!(lease),
      TransportError,
      "Failed to notify",
    );
    assertEquals(killed, true);
    assert(calls.some((call) => call.includes("'rm' '-f' '--'") && call.includes("lock-lease-")));
    await session.close();
  });
});
