import type { AfterLoopEndContext, AfterStepEndContext } from "../loop-hooks";
import {
  shouldInjectReminder,
  shouldContinueAfterLoop,
  type SubAgentManagerLike,
} from "../todo-continuation";

export interface TodoContinuationHookOptions {
  subAgentManager?: SubAgentManagerLike;
}

export function createTodoContinuationHook(
  options: TodoContinuationHookOptions = {},
): {
  afterStepEnd: (ctx: AfterStepEndContext) => Promise<void>;
  afterLoopEnd: (ctx: AfterLoopEndContext) => Promise<void>;
} {
  return {
    afterStepEnd: createTodoReminderHook(options),
    afterLoopEnd: createTodoLoopContinuationHook(options),
  };
}

function createTodoReminderHook(
  options: TodoContinuationHookOptions,
): (ctx: AfterStepEndContext) => Promise<void> {
  return async (ctx: AfterStepEndContext) => {
    const state = ctx.store.getState();
    const checkResult = shouldInjectReminder(state, Date.now(), options.subAgentManager);

    if (!checkResult.should) return;

    const currentStepIndex = state.steps.length - 1;
    ctx.store.getState().append({ type: "reminder", reminder: checkResult.reminder });
    ctx.store.setState({
      lastTodoReminderStepIndex: currentStepIndex,
      todoStepReminderCount: state.todoStepReminderCount + 1,
    });
  };
}

function createTodoLoopContinuationHook(
  options: TodoContinuationHookOptions,
): (ctx: AfterLoopEndContext) => Promise<void> {
  return async (ctx: AfterLoopEndContext) => {
    const state = ctx.store.getState();
    const checkResult = shouldContinueAfterLoop(
      state,
      ctx.loopEndStatus,
      Date.now(),
      options.subAgentManager,
    );

    if (!checkResult.should) return;

    const pendingCount = checkResult.pendingTodos.length;
    const lastPendingCount = state.lastTodoContinuationPendingCount;
    const newStagnationCount =
      lastPendingCount !== null && pendingCount >= lastPendingCount
        ? state.todoContinuationStagnationCount + 1
        : 0;

    ctx.store.getState().append({ type: "reminder", reminder: checkResult.reminder });
    ctx.store.setState({
      todoLoopContinuationCount: state.todoLoopContinuationCount + 1,
      todoContinuationStagnationCount: newStagnationCount,
      lastTodoContinuationPendingCount: pendingCount,
    });
  };
}
