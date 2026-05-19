import type { BackgroundTaskManager } from "../../../background/manager";
import type { AfterLoopEndContext } from "../loop-hooks";
import type { MemoryRoots } from "../../../memory/types";
import { createMemoryExtractionTask } from "../../../background/tasks/memory-extraction";
import {
  MIN_MESSAGES_FOR_EXTRACTION,
  MIN_CONTENT_LENGTH_FOR_EXTRACTION,
} from "../../../memory/constants";
import type { TextPart } from "../../../store/types";

export function createMemoryExtractionHook(
  btm: BackgroundTaskManager,
  memoryRoots: MemoryRoots,
  isCancelled?: () => boolean,
): (ctx: AfterLoopEndContext) => Promise<void> {
  return async (ctx: AfterLoopEndContext) => {
    if (isCancelled?.()) return;

    const state = ctx.store.getState();

    const userMessages = state.messages.filter((m) => m.role === "user");
    if (userMessages.length < MIN_MESSAGES_FOR_EXTRACTION) return;

    const totalContentLength = state.messages.reduce((sum, m) => {
      return (
        sum +
        m.parts
          .filter((p): p is TextPart => p.type === "text")
          .reduce((s, p) => s + p.text.length, 0)
      );
    }, 0);
    if (totalContentLength < MIN_CONTENT_LENGTH_FOR_EXTRACTION) return;

    const task = createMemoryExtractionTask(
      ctx.store,
      memoryRoots,
    );

    btm.dispatch(task.name, () =>
      isCancelled?.()
        ? Promise.resolve()
        : task.run({
            store: ctx.store,
            modelInfo: ctx.modelInfo,
            modelOptions: ctx.modelOptions,
            workspaceRoot: memoryRoots.project,
            abort: ctx.abort,
          }),
    );
  };
}
