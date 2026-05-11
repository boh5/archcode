import type { BackgroundTaskManager } from "../../../background/manager";
import type { Registry } from "../../../provider/index";
import type { AfterStepEndContext } from "../loop-hooks";
import { createTitleGenerationTask } from "../../../background/tasks/title-generation";

export function createTitleGenerationHook(
  btm: BackgroundTaskManager,
  providerRegistry: Registry,
): (ctx: AfterStepEndContext) => Promise<void> {
  let stepZeroTriggered = false;

  return async (ctx: AfterStepEndContext) => {
    if (stepZeroTriggered) return;

    const state = ctx.store.getState();
    if (state.title) return;

    const stepZero = state.steps.find(
      (s) => s.step === 0 && s.completedAt !== undefined,
    );
    if (!stepZero) return;

    stepZeroTriggered = true;

    const task = createTitleGenerationTask(ctx.store, providerRegistry);
    btm.dispatch(task.name, () => task.run({
      store: ctx.store,
      modelInfo: ctx.modelInfo,
      providerRegistry,
      workspaceRoot: process.cwd(),
      sessionsDir: "",
      abort: ctx.abort,
    }));
  };
}
