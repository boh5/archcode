import type { BackgroundTaskManager } from "../../../background/manager";
import type { AfterLoopEndContext } from "../loop-hooks";
import type { MemoryRoots } from "../../../memory/types";
import { createMemoryExtractionTask } from "../../../background/tasks/memory-extraction";
import {
  MIN_EXTRACTION_INTERVAL_MS,
  MIN_MESSAGES_FOR_EXTRACTION,
  MIN_CONTENT_LENGTH_FOR_EXTRACTION,
} from "../../../memory/constants";
import type { TextPart } from "../../../store/types";
import type { MemoryExtractionConfig } from "../../../config";

export function createMemoryExtractionHook(
  btm: BackgroundTaskManager,
  memoryRoots: MemoryRoots,
  isCancelled?: () => boolean,
  config?: MemoryExtractionConfig,
): (ctx: AfterLoopEndContext) => Promise<void> {
  const minMessages = config?.minMessages ?? MIN_MESSAGES_FOR_EXTRACTION;
  const minContentLength = config?.minContentLength ?? MIN_CONTENT_LENGTH_FOR_EXTRACTION;
  const cooldownMs = config?.cooldownMs ?? MIN_EXTRACTION_INTERVAL_MS;

  return async (ctx: AfterLoopEndContext) => {
    if (isCancelled?.()) return;

    const lastCompletedAt = btm.getLastCompletedAt("memory-extraction");
    if (
      lastCompletedAt !== undefined &&
      Date.now() - lastCompletedAt < cooldownMs
    ) {
      return;
    }

    const state = ctx.store.getState();
    const fromIndex = state.lastExtractionIndex;
    const newMessages = state.messages.slice(fromIndex);

    const userMessages = newMessages.filter((m) => m.role === "user");
    if (userMessages.length < minMessages) return;

    const totalContentLength = newMessages.reduce((sum, m) => {
      return (
        sum +
        m.parts
          .filter((p): p is TextPart => p.type === "text")
          .reduce((s, p) => s + p.text.length, 0)
      );
    }, 0);
    if (totalContentLength < minContentLength) return;

    const task = createMemoryExtractionTask(
      ctx.store,
      memoryRoots,
      fromIndex,
      { minMessages, minContentLength },
    );

    const dispatched = btm.dispatch(task.name, () =>
      isCancelled?.()
        ? Promise.resolve()
        : task.run({
            store: ctx.store,
            binding: ctx.binding,
            logger: ctx.logger,
            workspaceRoot: memoryRoots.project,
            abort: ctx.abort,
          }),
    );

    if (!dispatched) return;

    ctx.store.setState({
      lastExtractionIndex: state.messages.length,
      lastExtractionTime: Date.now(),
    });
  };
}
