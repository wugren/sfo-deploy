import { assertEquals, assertRejects } from "../_support/assert.ts";
import {
  formatInfoLine,
  type InfoLogFields,
  infoOperation,
  safeInfoLogger,
} from "../../src/logging.ts";

Deno.test("unit/logging: format emits single-line fields and omits undefined", () => {
  assertEquals(
    formatInfoLine("deployment started", {
      cluster: "demo",
      steps: 3,
      activate: false,
      missing: undefined,
      note: "hello\nworld\ttab",
    }),
    `deployment started cluster="demo" steps=3 activate=false note="hello world tab"`,
  );
});

Deno.test("unit/logging: safe logger is silent without callback and isolates failures", async () => {
  const silent = safeInfoLogger();
  await silent("not observed");

  const events: Array<[string, InfoLogFields | undefined]> = [];
  let calls = 0;
  const info = safeInfoLogger((message, fields) => {
    calls += 1;
    if (calls === 1) throw new Error("logger failed");
    if (calls === 2) return Promise.reject(new Error("logger rejected"));
    events.push([message, fields]);
  });
  await info("first failure");
  await info("second failure");
  await info("third success", { machine: "node-a" });
  assertEquals(events, [["third success", { machine: "node-a" }]]);
});

Deno.test("unit/logging: operation logs phases without changing result or error", async () => {
  const events: string[] = [];
  const info = safeInfoLogger((message) => {
    events.push(message);
  });
  const value = await infoOperation(info, "operation", { machine: "node-a" }, () => {
    events.push("work");
    return Promise.resolve(42);
  });
  assertEquals(value, 42);
  assertEquals(events[0], "operation started");
  assertEquals(events[1], "work");
  assertEquals(events[2], "operation completed");

  const failures: string[] = [];
  const failureInfo = safeInfoLogger((message, fields) => {
    failures.push(`${message}:${fields?.errorCategory}`);
  });
  await assertRejects(
    () =>
      infoOperation(
        failureInfo,
        "operation",
        { machine: "node-a" },
        () => Promise.reject(new Error("boom")),
      ),
    Error,
    "boom",
  );
  assertEquals(failures, ["operation started:undefined", "operation failed:Error"]);
});
