/** 旧密钥机制符号删除扫描；匹配 testplan 的 removed-symbol-scan 断言。 */

import { join } from "jsr:@std/path@1.1.6";

const FORBIDDEN = [
  "config_secrets",
  "file_secrets",
  "DEPLOYMENT_CONTEXT_PATH",
  "DeploymentContext",
  "TemporaryContextFile",
  "temporaryContextFile",
  "withTemporaryContextFile",
  "CONTEXT_ENVIRONMENT_VARIABLE",
  "prepareFileSecretDeployments",
  "stageFileSecretDeployments",
  "FileSecretDeployment",
  "deployFileSecret",
];

const ALLOWED_PREFIXES = [
  "src/history.ts", // 旧发布快照只读 codec（空列表且执行失败关闭）
  "tests/fixtures/history/", // 历史快照只读夹具
  "tests/contract/verify_secrets_contract.ts", // 扫描器自身
  "tests/contract/verify_independent_remote_scripts.ts", // 旧符号负向断言
  "README.md", // 文档说明旧机制已移除
  "docs/guides/", // 文档说明旧机制已移除
];

const ROOTS = ["src", "tests", "examples", "README.md", "docs/guides"];

function fail(message: string): never {
  console.error(`verify-secrets-contract: ${message}`);
  Deno.exit(1);
}

async function* walk(root: string): AsyncGenerator<string> {
  let info;
  try {
    info = await Deno.stat(root);
  } catch {
    return;
  }
  if (info.isFile) {
    yield root;
    return;
  }
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory) {
      if (entry.name === "__pycache__" || entry.name === ".pytest_cache") continue;
      yield* walk(path);
    } else if (entry.isFile && /\.(?:ts|py|ya?ml|md|json|sql|tpl|sh|ps1|example)$/.test(path)) {
      yield path;
    }
  }
}

async function collect(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const path of walk(root)) files.push(path);
  return files.sort();
}

const candidates: string[] = [];
for (const root of ROOTS) candidates.push(...await collect(root));
const violations: string[] = [];
for (const path of candidates) {
  if (ALLOWED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))) continue;
  const text = await Deno.readTextFile(path);
  for (const symbol of FORBIDDEN) {
    if (text.includes(symbol)) violations.push(`${path}: ${symbol}`);
  }
}
if (violations.length > 0) {
  fail(`removed secret symbols remain:\n${violations.map((item) => `  - ${item}`).join("\n")}`);
}
console.log("verify-secrets-contract: no removed secret symbols found");
