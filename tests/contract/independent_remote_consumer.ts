import type { PreparedExecution, PreparedStep } from "../../src/mod.ts";

export interface CurrentPreparedExecutionView {
  readonly localDirectory: string;
  readonly stepCount: number;
  readonly closed: boolean;
}

export function inspectPreparedExecution(value: PreparedExecution): CurrentPreparedExecutionView {
  return {
    localDirectory: value.localDirectory,
    stepCount: value.steps.size,
    closed: value.closed,
  };
}

export function inspectPreparedStep(value: PreparedStep): string {
  return `${value.step.id}:${value.artifact === undefined ? 0 : 1}`;
}
