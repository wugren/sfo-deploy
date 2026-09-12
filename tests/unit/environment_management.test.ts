import { assertEquals, assertRejects } from "../_support/assert.ts";
import { FakeSession } from "../_support/fake_session.ts";
import {
  convergeEnvironmentService,
  installEnvironmentPackages,
} from "../../src/environment_runtime.ts";
import { TransportError } from "../../src/errors.ts";
import type { EnvironmentPackageInstall, EnvironmentSystemManager } from "../../src/types.ts";

const packageInstall: EnvironmentPackageInstall = Object.freeze({
  kind: "package",
  manager: "auto",
  packages: ["nginx"],
  updateCache: true,
});

const systemManager: EnvironmentSystemManager = Object.freeze({
  kind: "system",
  name: "nginx",
  tool: "auto",
  enabled: true,
  startAfterInstall: true,
  timeoutMs: 30_000,
});

Deno.test("unit/environment runtime: installed apt packages skip cache update and install", async () => {
  const session = new FakeSession();
  await installEnvironmentPackages(session, packageInstall);
  assertEquals(session.pmCalls, []);
});

Deno.test("unit/environment runtime: missing apt packages update then install fixed argv", async () => {
  const session = new FakeSession(
    127,
    "",
    0,
    0,
    "",
    "/home/deploy",
    ["curl"],
    "/usr/bin/apt-get",
    0,
    0,
    true,
    undefined,
    1,
  );
  await installEnvironmentPackages(session, packageInstall);
  const update = session.pmCalls[0];
  const install = session.pmCalls[1];
  assertEquals(update.argv, ["/usr/bin/apt-get", "update"]);
  assertEquals(install.argv, [
    "/usr/bin/apt-get",
    "install",
    "-y",
    "--no-install-recommends",
    "nginx",
  ]);
  assertEquals(update.options.privileged, true);
  assertEquals(install.options.privileged, true);
});

Deno.test("unit/environment runtime: yum uses fixed install template", async () => {
  const session = new FakeSession(
    127,
    "",
    0,
    0,
    "",
    "/home/deploy",
    [],
    "/usr/bin/yum",
    0,
    0,
    true,
    undefined,
    0,
    1,
  );
  await installEnvironmentPackages(session, { ...packageInstall, updateCache: false });
  const install = session.pmCalls.at(-1);
  assertEquals(install?.argv, ["/usr/bin/yum", "install", "-y", "nginx"]);
});

Deno.test("unit/environment runtime: systemctl start enables and verifies", async () => {
  const session = new FakeSession();
  await convergeEnvironmentService(session, systemManager, "start");
  const args = session.calls.map((call) => call.argv);
  assertEquals(args.find((argv) => argv[1] === "enable"), [
    "/usr/bin/systemctl",
    "enable",
    "--",
    "nginx.service",
  ]);
  assertEquals(args.find((argv) => argv[1] === "start"), [
    "/usr/bin/systemctl",
    "start",
    "--",
    "nginx.service",
  ]);
});

Deno.test("unit/environment runtime: service restart uses SysV entry and chkconfig", async () => {
  const session = new FakeSession();
  await convergeEnvironmentService(session, { ...systemManager, tool: "service" }, "restart");
  const args = session.calls.map((call) => call.argv);
  assertEquals(args.find((argv) => argv[0] === "/usr/sbin/service"), [
    "/usr/sbin/service",
    "nginx",
    "restart",
  ]);
  assertEquals(args.find((argv) => argv[0] === "service"), ["service", "nginx", "status"]);
  assertEquals(args.find((argv) => argv[0] === "/usr/sbin/chkconfig"), [
    "/usr/sbin/chkconfig",
    "nginx",
    "on",
  ]);
});

Deno.test("unit/environment runtime: inactive service fails closed", async () => {
  const session = new FakeSession(
    127,
    "",
    0,
    0,
    "",
    "/home/deploy",
    ["curl"],
    "/usr/bin/apt-get",
    0,
    0,
    true,
    undefined,
    0,
    0,
    false,
  );
  await assertRejects(
    () => convergeEnvironmentService(session, systemManager, "start"),
    TransportError,
    "active",
  );
});
