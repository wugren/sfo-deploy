/** 验证 README 与 CLI 帮助中的默认人可读输出 / --json 契约示例一致。 */

import { join } from "jsr:@std/path@1.1.6";

function fail(message: string): never {
  console.error(`verify-cli-output-docs: ${message}`);
  Deno.exit(1);
}

const root = join(import.meta.dirname ?? ".", "..", "..");
const readme = await Deno.readTextFile(join(root, "README.md"));
for (const marker of ["按步骤输出中文人可读的进度行", "--json", "稳定 JSON 契约"]) {
  if (!readme.includes(marker)) {
    fail(`README 缺少输出契约标记: ${marker}`);
  }
}

const cliSource = await Deno.readTextFile(join(root, "src", "cli.ts"));
if (!cliSource.includes("以稳定 JSON 输出结果与错误（默认输出人类可读的分步进度）")) {
  fail("CLI 帮助文本缺少 --json 说明");
}

console.log("CLI 输出文档契约通过");
