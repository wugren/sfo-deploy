/** 从计划中的机器策略判断远端 Deno 是否允许执行，不探测目标系统。 */

import { PlanningError } from "./errors.ts";
import type { ExecutionPlan, PlanStep } from "./types.ts";

/** 只检查实际步骤会调用的 Deno 路径，不检查只是打包但未调用的脚本。 */
export function stepRequiresRemoteDeno(step: PlanStep): string | undefined {
  if (step.scripts.length > 0) {
    return `script ${step.scripts[0]!.relativePath}`;
  }
  if (!["deploy", "configure", "stage", "activate"].includes(step.action)) return undefined;
  const config = step.management?.configs.find((item) => item.secretReferences.size > 0);
  if (config === undefined) return undefined;
  const names = [...config.secretReferences.keys()].sort();
  return `config ${config.target} requires remote secret rendering (${names.join(", ")})`;
}

/** 禁用远端 Deno 时，所选步骤必须在任何远端部署写入前失败。 */
export function assertPlanDenoPolicy(plan: ExecutionPlan): void {
  for (const step of plan.steps) {
    if (step.machine.machine.enableDeno !== false) continue;
    const reason = stepRequiresRemoteDeno(step);
    if (reason === undefined) continue;
    throw new PlanningError(
      `Machine ${step.machine.machine.name} has enable_deno: false but ${step.kind} ${step.resource} requires remote Deno for ${reason}`,
    );
  }
}
