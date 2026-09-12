const flags = [
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-net",
  "--allow-run",
];

const suites = {
  unit: [
    "tests/unit/app_management_config.test.ts",
    "tests/unit/config_planning.test.ts",
    "tests/unit/service_management.test.ts",
    "tests/unit/history.test.ts",
    "tests/unit/history_regressions.test.ts",
  ],
  dv: [
    "tests/dv/app_management_execution.test.ts",
    "tests/dv/versioned_deploy_order.test.ts",
    "tests/dv/execution.test.ts",
  ],
  integration: [
    "tests/integration/versioned_release.test.ts",
    "tests/integration/versioned_transport_boundary.test.ts",
    "tests/integration/managed_transport_security.test.ts",
    "tests/integration/config_fingerprint.test.ts",
  ],
} as const;

const level = Deno.args[0];
if (!(level in suites)) {
  console.error(`unknown app lifecycle test level: ${level}`);
  Deno.exit(2);
}

const command = new Deno.Command("deno", {
  args: ["test", ...flags, ...suites[level as keyof typeof suites]],
  stdin: "inherit",
});
const status = await command.spawn().status;
Deno.exit(status.code);
