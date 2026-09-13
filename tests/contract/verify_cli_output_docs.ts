/** 验证 README 与 CLI 帮助中的默认人可读输出 / --json 契约示例一致。 */

import { join } from "jsr:@std/path@1.1.6";

function fail(message: string): never {
  console.error(`verify-cli-output-docs: ${message}`);
  Deno.exit(1);
}

const root = join(import.meta.dirname ?? ".", "..", "..");
const readme = await Deno.readTextFile(join(root, "README.md"));
for (const marker of ["按步骤输出英文人可读的进度行", "--json", "稳定 JSON 契约"]) {
  if (!readme.includes(marker)) {
    fail(`README is missing the output contract marker: ${marker}`);
  }
}

const cliSource = await Deno.readTextFile(join(root, "src", "cli.ts"));
if (
  !cliSource.includes(
    "Output results and errors as stable JSON (default: step-by-step human-readable progress)",
  )
) {
  fail("CLI help text is missing the --json description");
}

console.log("CLI output documentation contract passed");
