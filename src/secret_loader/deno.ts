/** 框架提供的受限秘密读取 loader（Deno 运行时，执行时以 sfo-secret-loader.ts 上传）。 */

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** 脚本运行时注入的步骤秘密副本目录变量。 */
export const DEPLOYMENT_SECRETS_DIR = "DEPLOYMENT_SECRETS_DIR";

export interface LoadSecretsOptions {
  readonly dir: string;
  readonly values?: readonly string[];
  readonly files?: readonly string[];
}

function validateSecretName(name: string): string {
  if (typeof name !== "string" || !SECRET_NAME_RE.test(name)) {
    throw new TypeError(`密钥名不合法: ${JSON.stringify(name)}`);
  }
  return name;
}

function validateDirectory(dir: string): string {
  if (typeof dir !== "string" || dir.length === 0 || dir.includes("\0") || dir.includes("\\")) {
    throw new TypeError(`秘密副本目录不合法: ${JSON.stringify(dir)}`);
  }
  const parts = dir.split("/");
  if (!dir.startsWith("/") || parts.includes("..") || dir === "/") {
    throw new TypeError(`秘密副本目录必须是安全绝对 POSIX 路径`);
  }
  return dir;
}

async function readTextFile(path: string, name: string): Promise<string> {
  let info: Deno.FileInfo;
  let content: string;
  try {
    info = await Deno.lstat(path);
    content = await Deno.readTextFile(path);
  } catch (cause) {
    throw new Error(`读取密钥 ${name} 失败`, { cause });
  }
  if (!info.isFile || info.isSymlink) {
    throw new Error(`密钥 ${name} 不是普通文件`);
  }
  return content;
}

/** 按名读取值密钥（返回非空字符串）与文件密钥（返回受限绝对路径）。 */
export async function loadSecrets(
  options: LoadSecretsOptions,
): Promise<{
  readonly values: Readonly<Record<string, string>>;
  readonly files: Readonly<Record<string, string>>;
}> {
  const dir = validateDirectory(options.dir);
  const valueNames = [...(options.values ?? [])].map(validateSecretName);
  const fileNames = [...(options.files ?? [])].map(validateSecretName);
  const duplicate = [...new Set([...valueNames, ...fileNames])].filter((name) =>
    valueNames.includes(name) && fileNames.includes(name)
  );
  if (duplicate.length > 0) {
    throw new Error(`密钥 ${duplicate.join("、")} 同时声明为值密钥与文件密钥`);
  }
  const values: Record<string, string> = {};
  for (const name of valueNames) {
    values[name] = await readTextFile(`${dir}/${name}`, name);
    if (values[name].length === 0) throw new Error(`密钥 ${name} 为空`);
  }
  const files: Record<string, string> = {};
  for (const name of fileNames) {
    const path = `${dir}/${name}`;
    const info = await Deno.lstat(path);
    if (!info.isFile || info.isSymlink) throw new Error(`密钥 ${name} 不是普通文件`);
    files[name] = path;
  }
  return Object.freeze({
    values: Object.freeze(values),
    files: Object.freeze(files),
  });
}
