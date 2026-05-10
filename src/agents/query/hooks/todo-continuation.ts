import type { AfterStepEndContext } from "../loop-hooks";
import {
  checkStagnation,
  computeTodoHash,
  shouldInjectContinuationReminder,
  type SubAgentManagerLike,
} from "../todo-continuation";

export interface TodoContinuationHookOptions {
  subAgentManager?: SubAgentManagerLike;
}

export function createTodoContinuationHook(
  options: TodoContinuationHookOptions = {},
): (ctx: AfterStepEndContext) => Promise<void> {
  let lastTodoHash: string | null = null;
  let stagnationCount = 0;
  let continuationCount = 0;

  return async (ctx: AfterStepEndContext) => {
    const state = ctx.store.getState();
    const lastStep = state.steps.at(-1);
    if (!lastStep) return;

    const finishReason = lastStep.finishReason ?? "stop";

    if (finishReason === "tool-calls") {
      const hash = computeTodoHash(state.todos);
      const result = checkStagnation(hash, lastTodoHash, stagnationCount);
      lastTodoHash = result.newHash;
      stagnationCount = result.newCount;

      if (result.isStagnant) {
        const checkResult = shouldInjectContinuationReminder(
          state,
          Date.now(),
          continuationCount,
          options.subAgentManager,
          { stagnationCount: result.newCount, trigger: "stagnation" },
        );
        if (checkResult.should) {
          ctx.store.getState().append({ type: "reminder", reminder: checkResult.reminder });
          continuationCount++;
        }
      }
    } else if (finishReason === "stop" || finishReason === "length") {
      const checkResult = shouldInjectContinuationReminder(
        state,
        Date.now(),
        continuationCount,
        options.subAgentManager,
        { trigger: "loop_end" },
      );
      if (checkResult.should) {
        ctx.store.getState().append({ type: "reminder", reminder: checkResult.reminder });
        continuationCount++;
      }
    }
  };
}
