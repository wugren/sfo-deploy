/** 验证 install-deno 的文档示例与公开动作契约保持一致。 */

import { join } from "jsr:@std/path@1.1.6";
import { CLI_ACTIONS } from "../../src/integration.ts";

function fail(message: string): never {
  throw new Error(message);
}

async function readFile(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (cause) {
    return fail(`无法读取契约输入 ${path}: ${(cause as Error).message}`);
  }
}

if (!(CLI_ACTIONS as readonly string[]).includes("install-deno")) {
  fail("CLI_ACTIONS 缺少 install-deno");
}

const root = join(import.meta.dirname ?? ".", "..", "..");
const docs: Array<[string, string]> = [
  [
    join(root, "README.md"),
    "sfo-deploy install-deno --cluster production",
  ],
  [
    join(root, "docs", "guides", "sfo-deploy-cluster-configuration.md"),
    "sfo-deploy install-deno --cluster production",
  ],
  [
    join(root, "examples", "eleph-server-multipass", "README.md"),
    "deno task eleph-deploy install-deno --cluster multipass --yes",
  ],
];

for (const [path, example] of docs) {
  const text = await readFile(path);
  if (!text.includes(example)) {
    fail(`${path} 缺少可执行示例: ${example}`);
  }
}

const autoInstallMentions: Array<[string, string]> = [
  [
    join(root, "README.md"),
    "提权安装",
  ],
  [
    join(root, "docs", "guides", "sfo-deploy-cluster-configuration.md"),
    "deno.land",
  ],
  [
    join(root, "examples", "eleph-server-multipass", "README.md"),
    "自动安装缺失的 curl 与 unzip",
  ],
];

for (const [path, marker] of autoInstallMentions) {
  const text = await readFile(path);
  if (!text.includes(marker)) {
    fail(`${path} 缺少自动补齐说明: ${marker}`);
  }
}

const noSyncMentions: Array<[string, string]> = [
  [
    join(root, "README.md"),
    "不修改 `machines.yaml`",
  ],
  [
    join(root, "docs", "guides", "sfo-deploy-cluster-configuration.md"),
    "也不修改",
  ],
  [
    join(root, "examples", "eleph-server-multipass", "README.md"),
    "不会修改",
  ],
];

for (const [path, marker] of noSyncMentions) {
  const text = await readFile(path);
  if (!text.includes(marker)) {
    fail(`${path} 缺少 install-deno 不修改 machines.yaml 说明: ${marker}`);
  }
}

const oldSyncPhrases = [
  "原子同步为实际安装路径",
  "`machines[].deno` 原子同步",
  "`machines.yaml.deno` 原子同步为",
  "把该机器在 `machines.yaml` 中的 `deno` 原子同步",
];

for (
  const path of [
    join(root, "README.md"),
    join(root, "docs", "guides", "sfo-deploy-cluster-configuration.md"),
    join(root, "examples", "eleph-server-multipass", "README.md"),
  ]
) {
  const text = await readFile(path);
  for (const phrase of oldSyncPhrases) {
    if (text.includes(phrase)) {
      fail(`${path} 仍包含已移除的自动同步旧说明: ${phrase}`);
    }
  }
}

console.log("install-deno 文档示例契约通过");
