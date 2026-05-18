import type { BackgroundTaskManager } from "../../../background/manager";
import { saveSessionTranscript } from "../../../store/helpers";
import type { AfterLoopEndContext } from "../loop-hooks";

export function createTranscriptSaveHook(
  btm: BackgroundTaskManager | undefined,
  workspaceRoot: string,
): (ctx: AfterLoopEndContext) => Promise<void> {
  return async (ctx: AfterLoopEndContext) => {
    if (btm !== undefined) {
      btm.dispatch("transcript-save", async () => saveTranscript(ctx, workspaceRoot));
      return;
    }

    await saveTranscript(ctx, workspaceRoot);
  };
}

async function saveTranscript(ctx: AfterLoopEndContext, workspaceRoot: string): Promise<void> {
  try {
    const { sessionId, createdAt, title, messages, steps, todos } =
      ctx.store.getState();
    await saveSessionTranscript(
      { sessionId, createdAt, title, messages, steps, todos },
      workspaceRoot,
    );
  } catch (err) {
    console.warn(
      "Transcript save hook failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
