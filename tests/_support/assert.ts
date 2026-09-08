import { deepStrictEqual } from "node:assert/strict";

type ErrorConstructor<E extends Error = Error> = new (...args: never[]) => E;

export function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

export function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  deepStrictEqual(actual, expected, message);
}

export function assertStringIncludes(actual: string, expected: string, message?: string): void {
  if (!actual.includes(expected)) {
    throw new Error(
      message ?? `Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`,
    );
  }
}

export function assertMatch(actual: string, expected: RegExp, message?: string): void {
  if (!expected.test(actual)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to match ${expected}`);
  }
}

export function assertExists<T>(
  value: T,
  message = "Expected value to exist",
): asserts value is NonNullable<T> {
  if (value === null || value === undefined) throw new Error(message);
}

export function assertThrows<E extends Error>(
  run: () => unknown,
  expected?: ErrorConstructor<E>,
  messageIncludes?: string,
): E {
  try {
    run();
  } catch (error) {
    return validateError(error, expected, messageIncludes);
  }
  throw new Error("Expected function to throw");
}

export async function assertRejects<E extends Error>(
  run: () => Promise<unknown>,
  expected?: ErrorConstructor<E>,
  messageIncludes?: string,
): Promise<E> {
  try {
    await run();
  } catch (error) {
    return validateError(error, expected, messageIncludes);
  }
  throw new Error("Expected function to reject");
}

function validateError<E extends Error>(
  error: unknown,
  expected?: ErrorConstructor<E>,
  messageIncludes?: string,
): E {
  if (!(error instanceof Error)) throw new Error(`Expected Error, got ${String(error)}`);
  if (expected && !(error instanceof expected)) {
    throw new Error(`Expected ${expected.name}, got ${error.constructor.name}: ${error.message}`);
  }
  if (messageIncludes && !error.message.includes(messageIncludes)) {
    throw new Error(
      `Expected error message ${JSON.stringify(error.message)} to include ${
        JSON.stringify(messageIncludes)
      }`,
    );
  }
  return error as E;
}

export async function withTempDir<T>(run: (path: string) => Promise<T>): Promise<T> {
  const path = await Deno.makeTempDir({ prefix: "sfo-deploy-test-" });
  try {
    return await run(path);
  } finally {
    await Deno.remove(path, { recursive: true }).catch(() => undefined);
  }
}

export class BufferWriter {
  readonly chunks: Uint8Array[] = [];

  write(data: Uint8Array): number {
    this.chunks.push(data.slice());
    return data.length;
  }

  text(): string {
    const size = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  }
}
