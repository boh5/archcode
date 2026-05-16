import type { BackgroundTaskManager } from "../../../background/manager";
import type { AfterLoopEndContext } from "../loop-hooks";
import { MemoryFileManager } from "../../../memory/file-manager";
import { createMemoryConsolidationTask } from "../../../background/tasks/memory-consolidation";
import { CONSOLIDATION_THRESHOLD } from "../../../memory/constants";

export function createMemoryConsolidationHook(
  btm: BackgroundTaskManager,
  memoryRoots: { project: string; user: string },
): (ctx: AfterLoopEndContext) => Promise<void> {
  return async (ctx: AfterLoopEndContext) => {
    const fileManager = new MemoryFileManager(memoryRoots);
    const indexContent = await fileManager.readIndex();
    if (indexContent === null) return;

    const lineCount = indexContent.split("\n").filter((l) => l.trim() !== "").length;
    if (lineCount <= CONSOLIDATION_THRESHOLD) return;

    const task = createMemoryConsolidationTask(memoryRoots);
    btm.dispatch(task.name, () =>
      task.run({
        store: ctx.store,
        modelInfo: ctx.modelInfo,
        modelOptions: ctx.modelOptions,
        workspaceRoot: memoryRoots.project,
        abort: ctx.abort,
      }),
    );
  };
}
