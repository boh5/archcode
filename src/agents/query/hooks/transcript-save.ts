import { getSessionsDir } from "../../../store/sessions-dir";
import { saveSessionTranscript } from "../../../store/helpers";
import type { AfterLoopEndContext } from "../loop-hooks";

export function createTranscriptSaveHook(
  sessionsDir?: string,
): (ctx: AfterLoopEndContext) => Promise<void> {
  const dir = sessionsDir ?? getSessionsDir();

  return async (ctx: AfterLoopEndContext): Promise<void> => {
    try {
      const { sessionId, createdAt, title, messages, steps, todos } =
        ctx.store.getState();
      await saveSessionTranscript(
        { sessionId, createdAt, title, messages, steps, todos },
        dir,
      );
    } catch (err) {
      console.warn(
        "Transcript save hook failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  };
}
