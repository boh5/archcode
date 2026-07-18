import type { BackgroundTaskManager } from "../../../background/manager";
import type { BeforeModelCallContext } from "../loop-hooks";
import { createTitleGenerationTask } from "../../../background/tasks/title-generation";

export function createTitleGenerationHook(
  btm: BackgroundTaskManager,
  workspaceRoot: string,
  isCancelled?: () => boolean,
): (ctx: BeforeModelCallContext) => Promise<void> {
  let triggered = false;

  return async (ctx: BeforeModelCallContext) => {
    if (triggered) return;
    if (isCancelled?.()) return;

    const state = ctx.store.getState();
    if (state.title) return;

    triggered = true;

    const task = createTitleGenerationTask(ctx.store);
    btm.dispatch(task.name, () => {
      if (isCancelled?.()) return Promise.resolve();
      return task.run({
        store: ctx.store,
        binding: ctx.binding,
        logger: ctx.logger,
        workspaceRoot,
        abort: ctx.abort,
      });
    });
  };
}
