import type { BackgroundTaskManager } from "../../../background/manager";
import type { AfterLoopEndContext } from "../loop-hooks";
import { MemoryFileManager } from "../../../memory/file-manager";
import { createMemoryConsolidationTask } from "../../../background/tasks/memory-consolidation";
import { CONSOLIDATION_THRESHOLD } from "../../../memory/constants";
import type { MemoryExtractionConfig } from "../../../config";

export function createMemoryConsolidationHook(
  btm: BackgroundTaskManager,
  memoryRoots: { project: string; user: string },
  isCancelled?: () => boolean,
  _config?: MemoryExtractionConfig,
): (ctx: AfterLoopEndContext) => Promise<void> {
  return async (ctx: AfterLoopEndContext) => {
    if (isCancelled?.()) return;

    const fileManager = new MemoryFileManager(memoryRoots);
    const indexContent = await fileManager.readIndex();
    if (indexContent === null) return;

    const lineCount = indexContent.split("\n").filter((l) => l.trim() !== "").length;
    if (lineCount <= CONSOLIDATION_THRESHOLD) return;

    const task = createMemoryConsolidationTask(memoryRoots);
    btm.dispatch(task.name, () =>
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
  };
}
