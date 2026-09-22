import { assert } from "../_support/assert.ts";

Deno.test("integration/operation-lock-docs: README 与配置指南说明租约 TTL 与心跳自动释放", async () => {
  const readme = await Deno.readTextFile("README.md");
  const guide = await Deno.readTextFile("docs/guides/sfo-deploy-cluster-configuration.md");
  assert(readme.includes("有界租约 TTL"), "README 需要说明控制端断连后有界租约自动释放");
  assert(readme.includes("心跳续租"), "README 需要说明控制端周期心跳续租");
  assert(guide.includes("有界租约 TTL"), "配置指南需要说明控制端断连后有界租约自动释放");
  assert(guide.includes("心跳"), "配置指南需要说明控制端周期心跳续租");
});
