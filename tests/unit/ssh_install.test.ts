import { assert, assertEquals, assertRejects, assertThrows } from "../_support/assert.ts";
import { FakeSession } from "../_support/fake_session.ts";
import { ConfigurationError, PreflightError, TransportError } from "../../src/errors.ts";
import {
  installDenoOnMachine,
  normalizeDenoVersion,
  validateInstallTo,
} from "../../src/ssh_install.ts";
import { quotePosix, validateArgv } from "../../src/transport.ts";

Deno.test("unit/ssh-install-deno: version normalization accepts x.y.z and vx.y.z", () => {
  assertEquals(normalizeDenoVersion("2.2.11"), "2.2.11");
  assertEquals(normalizeDenoVersion("v2.2.11"), "2.2.11");
  assertThrows(() => normalizeDenoVersion("2"), ConfigurationError, "x.y.z");
  assertThrows(() => normalizeDenoVersion("1.46.3"), ConfigurationError, "Deno 2");
  assertThrows(
    () => normalizeDenoVersion("2.2.11; touch /tmp/pwned"),
    ConfigurationError,
    "x.y.z",
  );
});

Deno.test("unit/ssh-install-deno: install directory accepts only safe absolute POSIX paths", () => {
  assertEquals(validateInstallTo(undefined), undefined);
  assertEquals(validateInstallTo("/usr/local"), "/usr/local");
  assertEquals(validateInstallTo("/opt/deno/bin"), "/opt/deno/bin");
  assertThrows(() => validateInstallTo("relative/path"), ConfigurationError);
  assertThrows(() => validateInstallTo("/home/deploy/../../etc"), ConfigurationError, "..");
  assertThrows(() => validateInstallTo("/bad path"), ConfigurationError);
});

Deno.test("unit/ssh-install-deno: satisfied version skips install", async () => {
  const session = new FakeSession(0, "deno 2.2.11\n");
  const outcome = await installDenoOnMachine(session, "node-a", {
    version: "2.2.11",
  });
  assertEquals(outcome.status, "present");
  assertEquals(outcome.denoPath, "/usr/local/bin/deno");
  assertEquals(outcome.version, "2.2.11");
  assertEquals(session.installCalls, 0);
  assertEquals(session.versionCalls, 1);
});

Deno.test("unit/ssh-install-deno: latest default upgrades an older deno", async () => {
  const session = new FakeSession(0, "deno 2.2.11\n", 0, 0, "deno 2.7.8\n");
  const outcome = await installDenoOnMachine(session, "node-a", {});
  assertEquals(outcome.status, "installed");
  assertEquals(outcome.version, "2.7.8");
  assertEquals(session.installCalls, 1);
  assertEquals(session.checksumChecked, true);
  assertEquals(session.installSkipped, false);
  const installer = session.calls.find((call) =>
    call.argv[0] === "/bin/sh" &&
    String(call.argv[2] ?? "").includes("github.com/denoland/deno/releases/")
  );
  const script = String(installer?.argv[2] ?? "");
  assert(script.includes("requested_version=''"));
  assert(script.includes("existing_version='2.2.11'"));
  assert(
    script.includes(
      "https://github.com/denoland/deno/releases/latest/download",
    ),
  );
  assert(script.includes(".sha256sum"));
});

Deno.test("unit/ssh-install-deno: latest default returns present when already latest", async () => {
  const session = new FakeSession(0, "deno 2.7.8\n", 0, 0, "deno 2.7.8\n");
  session.downloadedVersion = "2.7.8";
  const outcome = await installDenoOnMachine(session, "node-a", {});
  assertEquals(outcome.status, "present");
  assertEquals(outcome.version, "2.7.8");
  assertEquals(session.installCalls, 1);
  assertEquals(session.checksumChecked, true);
  assertEquals(session.installSkipped, true);
});

Deno.test("unit/ssh-install-deno: checksum failure fails closed", async () => {
  const session = new FakeSession(127, "", 0, 0, "deno 2.7.8\n");
  session.checksumExitCode = 1;
  await assertRejects(
    () => installDenoOnMachine(session, "node-a", {}),
    TransportError,
    "Failed to install Deno",
  );
  assertEquals(session.installCalls, 1);
  assertEquals(session.checksumChecked, true);
  assertEquals(session.installSkipped, false);
});

Deno.test("unit/ssh-install-deno: installer requires checksum and declares Linux targets", async () => {
  const session = new FakeSession(127, "", 0, 0, "deno 2.7.8\n");
  await installDenoOnMachine(session, "node-a", {});
  const installer = session.calls.find((call) =>
    call.argv[0] === "/bin/sh" &&
    String(call.argv[2] ?? "").includes("github.com/denoland/deno/releases/")
  );
  const script = String(installer?.argv[2] ?? "");
  assert(script.includes("command -v sha256sum"));
  assert(script.includes("x86_64-unknown-linux-gnu"));
  assert(script.includes("aarch64-unknown-linux-gnu"));
});

Deno.test("unit/ssh-install-deno: installs pinned version through ssh run and verifies", async () => {
  const session = new FakeSession(127, "", 0, 0, "deno 2.2.11\n");
  const outcome = await installDenoOnMachine(session, "node-a", {
    version: "v2.2.11",
    installTo: "/usr/local",
  });
  assertEquals(outcome.status, "installed");
  assertEquals(outcome.denoPath, "/usr/local/bin/deno");
  assertEquals(outcome.version, "2.2.11");
  assertEquals(session.installCalls, 1);
  assertEquals(session.versionCalls, 2);

  const installer = session.calls.find((call) =>
    call.argv[0] === "/bin/sh" &&
    String(call.argv[2] ?? "").includes("github.com/denoland/deno/releases/")
  );
  assertEquals(installer?.options.environment, { DENO_INSTALL: "/usr/local" });
  assertEquals(installer?.options.privileged, true);
  const script = String(installer?.argv[2] ?? "");
  assert(script.includes("requested_version='2.2.11'"));
  assert(script.includes("/releases/download/v2.2.11"));
  assert(!script.includes("/usr/local"));
});

Deno.test("unit/ssh-install-deno: installer script passes strict transport argv validation", async () => {
  const session = new FakeSession(127, "", 0, 0, "deno 2.2.11\n");
  await installDenoOnMachine(session, "node-a", { version: "2.2.11" });
  const installer = session.calls.find((call) =>
    call.argv[0] === "/bin/sh" &&
    String(call.argv[2] ?? "").includes("github.com/denoland/deno/releases/")
  );
  assert(installer !== undefined);
  const script = String(installer.argv[2]);
  assertEquals(validateArgv(installer.argv), installer.argv);
  const quoted = quotePosix(script);
  assert(quoted.startsWith("'") && quoted.endsWith("'"));
  assert(quoted.includes("'\\''"));
  assert(
    ![...script].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    }),
  );
  assert(script.includes("requested_version='2.2.11'"));
  assert(script.includes("set -eu"));
  assert(script.includes("missing curl or wget"));
  assert(script.includes("missing unzip or 7z"));
});

Deno.test("unit/ssh-install-deno: present toolset performs no package operations", async () => {
  const session = new FakeSession(127, "", 0, 0, "deno 2.2.11\n");
  const outcome = await installDenoOnMachine(session, "node-a", { version: "2.2.11" });
  assertEquals(outcome.status, "installed");
  assertEquals(session.pmCalls.length, 0);
});

Deno.test("unit/ssh-install-deno: wget/7z satisfy the downloader/unarchiver check", async () => {
  const session = new FakeSession(
    127,
    "",
    0,
    0,
    "deno 2.2.11\n",
    "/home/deploy",
    ["wget", "7z"],
  );
  const outcome = await installDenoOnMachine(session, "node-a", { version: "2.2.11" });
  assertEquals(outcome.status, "installed");
  assertEquals(session.pmCalls.length, 0);
});

Deno.test("unit/ssh-install-deno: missing downloader and unarchiver installs curl+unzip via apt-get", async () => {
  const session = new FakeSession(127, "", 0, 0, "deno 2.2.11\n", "/home/deploy", []);
  const outcome = await installDenoOnMachine(session, "node-a", { version: "2.2.11" });
  assertEquals(outcome.status, "installed");
  assertEquals(session.pmCalls.length, 2);
  const [update, install] = session.pmCalls;
  assertEquals(update.argv, ["/usr/bin/apt-get", "update"]);
  assertEquals(
    install.argv,
    ["/usr/bin/apt-get", "install", "-y", "--no-install-recommends", "curl", "unzip"],
  );
  assertEquals(update.options.privileged, true);
  assertEquals(install.options.privileged, true);
});

Deno.test("unit/ssh-install-deno: only the missing downloader is installed", async () => {
  const session = new FakeSession(127, "", 0, 0, "deno 2.2.11\n", "/home/deploy", ["unzip"]);
  await installDenoOnMachine(session, "node-a", { version: "2.2.11" });
  const install = session.pmCalls.find((call) => call.argv[1] === "install");
  assertEquals(install?.argv.filter((arg) => arg === "curl" || arg === "unzip"), ["curl"]);
});

Deno.test("unit/ssh-install-deno: only the missing unarchiver is installed", async () => {
  const session = new FakeSession(127, "", 0, 0, "deno 2.2.11\n", "/home/deploy", ["curl", "wget"]);
  await installDenoOnMachine(session, "node-a", { version: "2.2.11" });
  const install = session.pmCalls.find((call) => call.argv[1] === "install");
  assertEquals(install?.argv.filter((arg) => arg === "curl" || arg === "unzip"), ["unzip"]);
});

Deno.test("unit/ssh-install-deno: apk branch uses fixed add template", async () => {
  const session = new FakeSession(
    127,
    "",
    0,
    0,
    "deno 2.2.11\n",
    "/home/deploy",
    [],
    "/sbin/apk",
  );
  await installDenoOnMachine(session, "node-a", { version: "2.2.11" });
  const install = session.pmCalls.find((call) => call.argv[1] === "add");
  assertEquals(install?.argv, ["/sbin/apk", "add", "--no-cache", "curl", "unzip"]);
});

Deno.test("unit/ssh-install-deno: dnf branch uses fixed install template", async () => {
  const session = new FakeSession(
    127,
    "",
    0,
    0,
    "deno 2.2.11\n",
    "/home/deploy",
    [],
    "/usr/bin/dnf",
  );
  await installDenoOnMachine(session, "node-a", { version: "2.2.11" });
  const install = session.pmCalls.find((call) => call.argv[1] === "install");
  assertEquals(install?.argv, ["/usr/bin/dnf", "install", "-y", "curl", "unzip"]);
});

Deno.test("unit/ssh-install-deno: yum branch uses fixed install template", async () => {
  const session = new FakeSession(
    127,
    "",
    0,
    0,
    "deno 2.2.11\n",
    "/home/deploy",
    [],
    "/usr/bin/yum",
  );
  await installDenoOnMachine(session, "node-a", { version: "2.2.11" });
  const install = session.pmCalls.find((call) => call.argv[1] === "install");
  assertEquals(install?.argv, ["/usr/bin/yum", "install", "-y", "curl", "unzip"]);
});

Deno.test("unit/ssh-install-deno: missing package manager fails closed before installer", async () => {
  const session = new FakeSession(127, "", 0, 0, "deno 2.2.11\n", "/home/deploy", [], "");
  await assertRejects(
    () => installDenoOnMachine(session, "node-a", { version: "2.2.11" }),
    TransportError,
    "has no usable package manager",
  );
  assertEquals(session.installCalls, 0);
});

Deno.test("unit/ssh-install-deno: apt update failure fails closed", async () => {
  const session = new FakeSession(
    127,
    "",
    0,
    0,
    "deno 2.2.11\n",
    "/home/deploy",
    [],
    "/usr/bin/apt-get",
    1,
  );
  await assertRejects(
    () => installDenoOnMachine(session, "node-a", { version: "2.2.11" }),
    TransportError,
    "Failed to refresh the apt package index",
  );
});

Deno.test("unit/ssh-install-deno: package install failure fails closed", async () => {
  const session = new FakeSession(
    127,
    "",
    0,
    0,
    "deno 2.2.11\n",
    "/home/deploy",
    [],
    "/usr/bin/apt-get",
    0,
    9,
  );
  await assertRejects(
    () => installDenoOnMachine(session, "node-a", { version: "2.2.11" }),
    TransportError,
    "Failed to install remote base tools",
  );
});

Deno.test("unit/ssh-install-deno: re-probe after install still missing fails closed", async () => {
  const session = new FakeSession(
    127,
    "",
    0,
    0,
    "deno 2.2.11\n",
    "/home/deploy",
    [],
    "/usr/bin/apt-get",
    0,
    0,
    false,
  );
  await assertRejects(
    () => installDenoOnMachine(session, "node-a", { version: "2.2.11" }),
    TransportError,
    "still missing",
  );
});

Deno.test("unit/ssh-install-deno: privilege failure during tool install maps to preflight error", async () => {
  const session = new FakeSession(
    127,
    "",
    0,
    0,
    "deno 2.2.11\n",
    "/home/deploy",
    [],
    "/usr/bin/apt-get",
    0,
    0,
    true,
    new PreflightError("Remote identity is neither root nor able to use non-interactive sudo"),
  );
  await assertRejects(
    () => installDenoOnMachine(session, "node-a", { version: "2.2.11" }),
    PreflightError,
    "sudo",
  );
  assertEquals(session.installCalls, 0);
});

Deno.test("unit/ssh-install-deno: satisfied deno skips tool remediation entirely", async () => {
  const session = new FakeSession(0, "deno 2.2.11\n", 0, 0, "deno 2.2.11\n", "/home/deploy", []);
  const outcome = await installDenoOnMachine(session, "node-a", { version: "2.2.11" });
  assertEquals(outcome.status, "present");
  assertEquals(session.pmCalls.length, 0);
  assertEquals(session.installCalls, 0);
});

Deno.test("unit/ssh-install-deno: tool and package-manager probes pass strict argv validation", async () => {
  const session = new FakeSession(127, "", 0, 0, "deno 2.2.11\n", "/home/deploy", []);
  await installDenoOnMachine(session, "node-a", { version: "2.2.11" });
  const probes = session.calls.filter((call) =>
    call.argv[0] === "/bin/sh" &&
    (String(call.argv[2] ?? "").includes("for tool in curl wget unzip 7z") ||
      String(call.argv[2] ?? "").includes("for path in /usr/bin/apt-get"))
  );
  assertEquals(probes.length, 3);
  for (const probe of probes) {
    assertEquals(validateArgv(probe.argv), probe.argv);
    const script = String(probe.argv[2]);
    assert(
      ![...script].some((character) => {
        const code = character.codePointAt(0)!;
        return code < 32 || code === 127;
      }),
    );
  }
});

Deno.test("unit/ssh-install-deno: default install goes to /usr/local with privilege", async () => {
  const session = new FakeSession(127, "", 0, 0, "deno 2.2.11\n");
  await installDenoOnMachine(session, "node-a", { version: "2.2.11" });
  const installer = session.calls.find((call) =>
    call.argv[0] === "/bin/sh" &&
    String(call.argv[2] ?? "").includes("github.com/denoland/deno/releases/")
  );
  assertEquals(installer?.options.environment, { DENO_INSTALL: "/usr/local" });
  assertEquals(installer?.options.privileged, true);
});

Deno.test("unit/ssh-install-deno: explicit home install stays without privilege", async () => {
  const session = new FakeSession(127, "", 0, 0, "deno 2.2.11\n");
  await installDenoOnMachine(session, "node-a", {
    version: "2.2.11",
    installTo: "/home/deploy/.deno",
  });
  const installer = session.calls.find((call) =>
    call.argv[0] === "/bin/sh" &&
    String(call.argv[2] ?? "").includes("github.com/denoland/deno/releases/")
  );
  assertEquals(installer?.options.environment, { DENO_INSTALL: "/home/deploy/.deno" });
  assertEquals(installer?.options.privileged, false);
});

Deno.test("unit/ssh-install-deno: install failure raises transport error", async () => {
  const session = new FakeSession(127, "", 9, 0, "deno 2.2.11\n");
  await assertRejects(
    () => installDenoOnMachine(session, "node-a", { version: "2.2.11" }),
    TransportError,
    "Failed to install Deno",
  );
});

Deno.test("unit/ssh-install-deno: post-install verification rejects version mismatch", async () => {
  const session = new FakeSession(127, "", 0, 0, "deno 2.3.0\n");
  await assertRejects(
    () => installDenoOnMachine(session, "node-a", { version: "2.2.11" }),
    TransportError,
    "version mismatch",
  );
});

Deno.test("unit/ssh-install-deno: missing remote home fails closed", async () => {
  const session = new FakeSession(127, "", 0, 0, "deno 2.2.11\n", "not-absolute");
  await assertRejects(
    () => installDenoOnMachine(session, "node-a", { version: "2.2.11" }),
    TransportError,
    "home directory",
  );
});
