import type { BeforeModelCallContext, AfterStepEndContext } from "../agents/query/loop-hooks";
import type { ToolExecutionOrigin } from "../tools/types";
import { LoopBudgetHardStopError, LoopBudgetLedger } from "./budget-ledger";

export interface LoopBudgetExecutionControl {
  abortSessionExecutionAndWait(workspaceRoot: string, sessionId: string): Promise<void>;
}

export interface LoopBudgetHookContext {
  readonly origin?: ToolExecutionOrigin;
  readonly abortSessionExecutionAndWait?: LoopBudgetExecutionControl["abortSessionExecutionAndWait"];
}

export function createLoopBudgetEnforcementHooks(control: LoopBudgetHookContext = {}) {
  return {
    beforeModelCall: async (ctx: BeforeModelCallContext): Promise<void> => {
      await enforceLoopBudgetBeforeModelCall(ctx, control);
    },
    afterStepEnd: async (ctx: AfterStepEndContext): Promise<void> => {
      await enforceLoopBudgetAfterStepEnd(ctx, control);
    },
  };
}

export async function enforceLoopBudgetBeforeModelCall(
  ctx: BeforeModelCallContext,
  control: LoopBudgetHookContext = {},
): Promise<void> {
  const resolved = resolveLoopContext(ctx, control);
  if (resolved === undefined) return;

  const { ledger, loopId, runId } = resolved;
  const { status } = await ledger.refreshWallClock(loopId, "before_model_call", runId);
  if (status.level === "hard") {
    await hardStop(ctx, resolved, "before_model_call");
  }
}

export async function enforceLoopBudgetAfterStepEnd(
  ctx: AfterStepEndContext,
  control: LoopBudgetHookContext = {},
): Promise<void> {
  const resolved = resolveLoopContext(ctx, control);
  if (resolved === undefined) return;

  const latestUsage = ctx.store.getState().steps.at(-1)?.usage;
  const { status } = await resolved.ledger.recordModelUsage({
    loopId: resolved.loopId,
    runId: resolved.runId,
    sessionId: ctx.store.getState().sessionId,
    rawUsage: latestUsage,
    modelInfo: ctx.modelInfo,
    source: "after_step_end",
  });
  if (status.level === "hard") {
    await hardStop(ctx, resolved, "after_step_end");
  }
}

function resolveLoopContext(
  ctx: BeforeModelCallContext | AfterStepEndContext,
  control: LoopBudgetHookContext,
): {
  ledger: LoopBudgetLedger;
  loopId: string;
  runId?: string;
  abortSessionExecutionAndWait?: LoopBudgetExecutionControl["abortSessionExecutionAndWait"];
} | undefined {
  const projectContext = ctx.projectContext;
  if (projectContext === undefined) return undefined;

  const state = ctx.store.getState();
  const origin = control.origin;
  const loopId = origin?.kind === "loop" ? origin.loopId : state.loopId;
  if (loopId === undefined) return undefined;

  return {
    ledger: new LoopBudgetLedger({ stateManager: projectContext.loopState, workspaceRoot: projectContext.project.workspaceRoot }),
    loopId,
    runId: origin?.kind === "loop" ? origin.runId : undefined,
    abortSessionExecutionAndWait: control.abortSessionExecutionAndWait,
  };
}

async function hardStop(
  ctx: BeforeModelCallContext | AfterStepEndContext,
  resolved: {
    ledger: LoopBudgetLedger;
    loopId: string;
    runId?: string;
    abortSessionExecutionAndWait?: LoopBudgetExecutionControl["abortSessionExecutionAndWait"];
  },
  source: string,
): Promise<never> {
  const state = ctx.store.getState();
  await resolved.ledger.recordHardExceeded({
    loopId: resolved.loopId,
    runId: resolved.runId,
    sessionId: state.sessionId,
    source,
    summary: "Loop hard budget exceeded; run paused until user action.",
  });
  if (resolved.abortSessionExecutionAndWait !== undefined) {
    void resolved.abortSessionExecutionAndWait(ctx.projectContext!.project.workspaceRoot, state.sessionId);
  }
  throw new LoopBudgetHardStopError(resolved.loopId, "Loop paused: hard budget exceeded");
}
