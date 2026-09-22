import { assertEquals, assertRejects } from "../_support/assert.ts";
import { FakeSession } from "../_support/fake_session.ts";
import { type CommandResult, commandResult } from "../../src/results.ts";
import { TransportError } from "../../src/errors.ts";
import type { RemoteRunOptions } from "../../src/transport.ts";
import {
  chkconfigName,
  probeChkconfig,
  readServiceEnabled,
  setServiceEnabled,
} from "../../src/service_enable.ts";

const SYSTEMD = {
  tool: "systemctl" as const,
  path: "systemctl",
  unit: "demo.service",
  timeoutMs: 900,
};
const SYSV = { tool: "service" as const, path: "service", unit: "demo.service", timeoutMs: 900 };

class EnableSession extends FakeSession {
  readonly enableCalls: Array<{ argv: readonly string[]; options: RemoteRunOptions }> = [];
  chkconfigPath = "/usr/sbin/chkconfig";
  chkconfigExitCode = 0;
  chkconfigStdout = "demo 0:off 1:off 2:on 3:on 4:on 5:on 6:off\n";
  setExitCode = 0;

  override run(argv: readonly string[], options: RemoteRunOptions = {}): Promise<CommandResult> {
    if (argv[0] === "/bin/sh" && argv[1] === "-c" && argv[2]?.includes("/usr/sbin/chkconfig")) {
      return Promise.resolve(
        this.chkconfigPath.length === 0
          ? commandResult(1)
          : commandResult(0, `${this.chkconfigPath}\n`),
      );
    }
    if (argv[0].endsWith("chkconfig")) {
      this.enableCalls.push({ argv: [...argv], options });
      if (argv[1] === "--list") {
        return Promise.resolve(commandResult(this.chkconfigExitCode, this.chkconfigStdout));
      }
      return Promise.resolve(commandResult(this.setExitCode));
    }
    if (argv[0] === "systemctl") {
      this.enableCalls.push({ argv: [...argv], options });
      return Promise.resolve(commandResult(0, "enabled\n"));
    }
    return super.run(argv, options);
  }
}

Deno.test("unit/service enable: chkconfigName strips the systemd suffix", () => {
  assertEquals(chkconfigName("nginx.service"), "nginx");
  assertEquals(chkconfigName("nginx"), "nginx");
});

Deno.test("unit/service enable: probeChkconfig fails closed when missing", async () => {
  const session = new EnableSession();
  session.chkconfigPath = "";
  await assertRejects(() => probeChkconfig(session), TransportError);
  assertEquals((await probeChkconfig(new EnableSession())).length > 0, true);
});

Deno.test("unit/service enable: systemd is-enabled maps enabled states", async () => {
  class SystemdReadSession extends FakeSession {
    constructor(readonly code: number, readonly output: string) {
      super();
    }
    override run(argv: readonly string[], options: RemoteRunOptions = {}): Promise<CommandResult> {
      if (argv[0] === "systemctl") {
        return Promise.resolve(commandResult(this.code, this.output));
      }
      return super.run(argv, options);
    }
  }
  assertEquals(
    (await readServiceEnabled(new SystemdReadSession(0, "enabled\n"), SYSTEMD)).enabled,
    true,
  );
  assertEquals(
    (await readServiceEnabled(new SystemdReadSession(1, "disabled\n"), SYSTEMD)).enabled,
    false,
  );
  const missing = await readServiceEnabled(new SystemdReadSession(4, "not-found\n"), SYSTEMD);
  assertEquals(missing.enabled, false);
  assertEquals(missing.enabledState, "not-found");
  await assertRejects(
    () => readServiceEnabled(new SystemdReadSession(5, "weird\n"), SYSTEMD),
    TransportError,
  );
});

Deno.test("unit/service enable: SysV chkconfig runlevel list decides enabled", async () => {
  const enabled = new EnableSession();
  assertEquals((await readServiceEnabled(enabled, SYSV)).enabled, true);
  const disabled = new EnableSession();
  disabled.chkconfigStdout = "demo 0:off 1:off 2:on 3:off 4:on 5:on 6:off\n";
  assertEquals((await readServiceEnabled(disabled, SYSV)).enabled, false);
  const single = new EnableSession();
  single.chkconfigStdout = "demo on\n";
  assertEquals((await readServiceEnabled(single, SYSV)).enabled, true);
  const unparseable = new EnableSession();
  unparseable.chkconfigStdout = "garbage\n";
  await assertRejects(() => readServiceEnabled(unparseable, SYSV), TransportError);
});

Deno.test("unit/service enable: SysV chkconfig read fails closed on non-zero exit", async () => {
  const session = new EnableSession();
  session.chkconfigExitCode = 1;
  await assertRejects(() => readServiceEnabled(session, SYSV), TransportError);
});

Deno.test("unit/service enable: systemctl enable/disable uses fixed argv", async () => {
  const session = new EnableSession();
  await setServiceEnabled(session, SYSTEMD, true);
  await setServiceEnabled(session, SYSTEMD, false);
  assertEquals(session.enableCalls.map((call) => call.argv), [
    ["systemctl", "enable", "--", "demo.service"],
    ["systemctl", "disable", "--", "demo.service"],
  ]);
});

Deno.test("unit/service enable: SysV enable/disable uses chkconfig on/off", async () => {
  const session = new EnableSession();
  await setServiceEnabled(session, SYSV, true);
  await setServiceEnabled(session, SYSV, false);
  assertEquals(session.enableCalls.map((call) => call.argv), [
    ["/usr/sbin/chkconfig", "demo", "on"],
    ["/usr/sbin/chkconfig", "demo", "off"],
  ]);
  session.setExitCode = 1;
  await assertRejects(() => setServiceEnabled(session, SYSV, true), TransportError);
});
