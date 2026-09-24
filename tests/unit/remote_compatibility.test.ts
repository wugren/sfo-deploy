import { assertPlanDenoPolicy, stepRequiresRemoteDeno } from "../../src/remote_compatibility.ts";
import { PlanningError } from "../../src/errors.ts";
import type { ExecutionPlan, ManagedConfigFile, PlanStep } from "../../src/types.ts";
import { assertEquals, assertStringIncludes, assertThrows } from "../_support/assert.ts";
import { plan } from "../_support/fixtures.ts";

function config(secret = "DB_PASSWORD"): ManagedConfigFile {
  return {
    name: "file-0",
    relativePath: "templates/application.json",
    source: "/cluster/templates/application.json",
    target: "/etc/demo/application.json",
    targetRoot: "absolute",
    mode: 0o600,
    variables: [],
    format: "json",
    secretReferences: new Map(secret ? [[secret, { kind: "value", valueType: "string" }]] : []),
    onChange: "none",
  };
}

function withSteps(steps: readonly PlanStep[]): ExecutionPlan {
  return { ...plan(), steps };
}

function withPolicy(step: PlanStep, enableDeno: boolean | undefined): PlanStep {
  return {
    ...step,
    machine: {
      ...step.machine,
      machine: { ...step.machine.machine, enableDeno },
    },
  };
}

function scriptless(step: PlanStep): PlanStep {
  return { ...step, scripts: [] };
}

Deno.test("unit/remote-compatibility: recognizes only invoked scripts and real config secrets", () => {
  const base = plan().steps[0]!;
  assertStringIncludes(stepRequiresRemoteDeno(base)!, "scripts/action.ts");
  assertEquals(stepRequiresRemoteDeno(scriptless(base)), undefined);
  const managed = (secret: string): PlanStep => ({
    ...scriptless(base),
    management: { configs: [config(secret)], configScripts: [] },
  });
  assertStringIncludes(stepRequiresRemoteDeno(managed("DB_PASSWORD"))!, "DB_PASSWORD");
  assertStringIncludes(stepRequiresRemoteDeno(managed("APP_VERSION"))!, "APP_VERSION");
  assertEquals(stepRequiresRemoteDeno(managed("")), undefined);
  assertEquals(stepRequiresRemoteDeno({ ...managed("DB_PASSWORD"), action: "start" }), undefined);
});

Deno.test("unit/remote-compatibility: disabled machine rejects a selected script", () => {
  const step = withPolicy(plan().steps[0]!, false);
  const error = assertThrows(() => assertPlanDenoPolicy(withSteps([step])), PlanningError);
  assertStringIncludes(error.message, "node-a");
  assertStringIncludes(error.message, "enable_deno: false");
  assertStringIncludes(error.message, "scripts/action.ts");
});

Deno.test("unit/remote-compatibility: disabled machine rejects secret rendering", () => {
  const step = withPolicy({
    ...scriptless(plan().steps[0]!),
    management: { configs: [config()], configScripts: [] },
  }, false);
  const error = assertThrows(() => assertPlanDenoPolicy(withSteps([step])), PlanningError);
  assertStringIncludes(error.message, "/etc/demo/application.json");
  assertStringIncludes(error.message, "DB_PASSWORD");
});

Deno.test("unit/remote-compatibility: disabled machine permits scriptless release and unselected scripts", () => {
  const base = plan().steps[0]!;
  const allowed = withPolicy(scriptless(base), false);
  assertEquals(assertPlanDenoPolicy(withSteps([allowed])), undefined);
  assertEquals(assertPlanDenoPolicy(withSteps([withPolicy(base, true)])), undefined);
  assertEquals(assertPlanDenoPolicy(withSteps([withPolicy(base, undefined)])), undefined);
});
