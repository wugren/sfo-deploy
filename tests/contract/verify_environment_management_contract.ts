/** 校验 Environment install/manager 契约在源码、测试与文档中的关键示例。 */

const requiredFiles = [
  "src/types.ts",
  "src/environment_runtime.ts",
  "tests/unit/environment_management.test.ts",
  "tests/unit/environment_management_planning.test.ts",
  "tests/dv/environment_management_execution.test.ts",
  "tests/integration/environment_management_history.test.ts",
  "README.md",
  "docs/guides/sfo-deploy-cluster-configuration.md",
  "skills/sfo-deploy-cluster/references/environment.md",
];

for (const file of requiredFiles) {
  const text = await Deno.readTextFile(file);
  if (text.trim().length === 0) {
    console.error(`${file} 不能为空`);
    Deno.exit(1);
  }
}

const guide = await Deno.readTextFile("docs/guides/sfo-deploy-cluster-configuration.md");
for (
  const token of [
    "### 新生命周期：install/manager",
    "install.kind: package",
    "manager.kind: system",
    "tool: auto",
    "`manager` 可缺省",
    "start/stop/restart",
    "新契约不声明 `check`",
  ]
) {
  if (!guide.includes(token)) {
    console.error(`配置指南缺少契约说明: ${token}`);
    Deno.exit(1);
  }
}

const runtime = await Deno.readTextFile("src/environment_runtime.ts");
for (
  const token of [
    "installEnvironmentPackages",
    "convergeEnvironmentService",
    "/usr/bin/apt-get",
    "/usr/bin/yum",
    "/usr/bin/systemctl",
    "service",
  ]
) {
  if (!runtime.includes(token)) {
    console.error(`环境运行时缺少契约实现: ${token}`);
    Deno.exit(1);
  }
}

const types = await Deno.readTextFile("src/types.ts");
for (
  const token of [
    "EnvironmentPackageInstall",
    "EnvironmentSystemManager",
    "EnvironmentScriptManager",
    "environmentInstall",
    "environmentManager",
  ]
) {
  if (!types.includes(token)) {
    console.error(`类型契约缺少: ${token}`);
    Deno.exit(1);
  }
}
