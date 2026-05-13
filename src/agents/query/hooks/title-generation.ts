import type { BackgroundTaskManager } from "../../../background/manager";
import type { BeforeModelCallContext } from "../loop-hooks";
import { createTitleGenerationTask } from "../../../background/tasks/title-generation";

export function createTitleGenerationHook(
  btm: BackgroundTaskManager,
): (ctx: BeforeModelCallContext) => Promise<void> {
  let triggered = false;

  return async (ctx: BeforeModelCallContext) => {
    if (triggered) return;

    const state = ctx.store.getState();
    if (state.title) return;

    triggered = true;

    const task = createTitleGenerationTask(ctx.store);
    btm.dispatch(task.name, () => task.run({
      store: ctx.store,
      modelInfo: ctx.modelInfo,
      workspaceRoot: process.cwd(),
      abort: ctx.abort,
    }));
  };
}
