import type { AfterLoopEndContext, AfterStepEndContext } from "../loop-hooks";
import {
  shouldInjectReminder,
  shouldContinueAfterLoop,
} from "../todo-continuation";

export function createTodoContinuationHook(
): {
  afterStepEnd: (ctx: AfterStepEndContext) => Promise<void>;
  afterLoopEnd: (ctx: AfterLoopEndContext) => Promise<void>;
} {
  return {
    afterStepEnd: createTodoReminderHook(),
    afterLoopEnd: createTodoLoopContinuationHook(),
  };
}

function createTodoReminderHook(
): (ctx: AfterStepEndContext) => Promise<void> {
  return async (ctx: AfterStepEndContext) => {
    const state = ctx.store.getState();
    const checkResult = shouldInjectReminder(state, Date.now());

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
): (ctx: AfterLoopEndContext) => Promise<void> {
  return async (ctx: AfterLoopEndContext) => {
    const state = ctx.store.getState();
    const checkResult = shouldContinueAfterLoop(
      state,
      ctx.loopEndStatus,
      Date.now(),
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
