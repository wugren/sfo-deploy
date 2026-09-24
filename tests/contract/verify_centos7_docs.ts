/** Keep the public machine Deno policy and offline plan boundary documented. */

import { assertEquals, assertStringIncludes } from "../_support/assert.ts";

const readme = await Deno.readTextFile("README.md");
const guide = await Deno.readTextFile("docs/guides/sfo-deploy-cluster-configuration.md");

for (const document of [readme, guide]) {
  assertStringIncludes(document, "enable_deno");
  assertStringIncludes(document, "不连接 SSH");
  assertStringIncludes(document, "Deno");
}
assertStringIncludes(readme, "缺省 `enable_deno: true`");
assertStringIncludes(guide, "设为 `false` 时");
assertStringIncludes(guide, "运行时不可用或版本不足会报错");
assertStringIncludes(guide, "禁用时计划阶段会拒绝这类配置");
assertEquals(guide.includes("CentOS 7 不支持这类配置"), false);
