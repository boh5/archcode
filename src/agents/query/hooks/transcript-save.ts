import type { BackgroundTaskManager } from "../../../background/manager";
import { saveSessionTranscript } from "../../../store/helpers";
import type { AfterLoopEndContext } from "../loop-hooks";

export function createTranscriptSaveHook(btm?: BackgroundTaskManager): (ctx: AfterLoopEndContext) => Promise<void> {
  return async (ctx: AfterLoopEndContext): Promise<void> => {
    if (btm !== undefined) {
      btm.dispatch("transcript-save", async () => saveTranscript(ctx));
      return;
    }

    await saveTranscript(ctx);
  };
}

async function saveTranscript(ctx: AfterLoopEndContext): Promise<void> {
  try {
    const { sessionId, createdAt, title, messages, steps, todos } =
      ctx.store.getState();
    await saveSessionTranscript(
      { sessionId, createdAt, title, messages, steps, todos },
    );
  } catch (err) {
    console.warn(
      "Transcript save hook failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
