/** 统一 info 日志契约；日志失败不得影响部署语义。 */

export type InfoLogValue = string | number | boolean | null | undefined;
export type InfoLogFields = Readonly<Record<string, InfoLogValue>>;

export type InfoLogger = (
  message: string,
  fields?: InfoLogFields,
) => void | Promise<void>;

export type SafeInfoLogger = (
  message: string,
  fields?: InfoLogFields,
) => Promise<void>;

/** 将用户回调转换为永不抛错、永不为 undefined 的 info logger。 */
export function safeInfoLogger(logger?: InfoLogger): SafeInfoLogger {
  return async (message: string, fields?: InfoLogFields): Promise<void> => {
    if (logger === undefined) return;
    try {
      await logger(message, fields);
    } catch {
      // 可观测性失败不是部署失败；不产生递归日志。
    }
  };
}

/** 输出单行 info 日志；字段值只支持安全标量，避免对象携带秘密。 */
export function formatInfoLine(
  message: string,
  fields: InfoLogFields = {},
): string {
  const parts = [singleLine(message)];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${formatInfoValue(value)}`);
  }
  return parts.join(" ");
}

/** 记录一次关键操作的开始、完成与失败；失败消息仍由最终错误路径负责。 */
export async function infoOperation<T>(
  info: SafeInfoLogger,
  message: string,
  fields: InfoLogFields,
  operation: () => Promise<T>,
): Promise<T> {
  await info(`${message} started`, fields);
  const startedAt = Date.now();
  try {
    const result = await operation();
    await info(`${message} completed`, { ...fields, durationMs: Date.now() - startedAt });
    return result;
  } catch (cause) {
    await info(`${message} failed`, {
      ...fields,
      durationMs: Date.now() - startedAt,
      errorCategory: errorCategory(cause),
    });
    throw cause;
  }
}

function errorCategory(cause: unknown): string {
  if (cause instanceof Deno.errors.NotFound) return "not-found";
  if (cause instanceof DOMException && cause.name === "AbortError") return "cancelled";
  if (cause instanceof Error) return cause.name;
  return "error";
}

function singleLine(value: string): string {
  // 控制台消息来自固定动作名和安全摘要；剥离控制字符防止日志注入。
  return value.replace(/[\p{C}\s]+/gu, " ").trim();
}

function formatInfoValue(value: Exclude<InfoLogValue, undefined>): string {
  if (typeof value === "string") return JSON.stringify(singleLine(value));
  if (value === null) return "null";
  return String(value);
}
