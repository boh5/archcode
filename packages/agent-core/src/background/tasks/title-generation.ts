import type { StoreApi } from "zustand/vanilla";
import type { BackgroundTask, BackgroundTaskContext } from "../types";
import type { SessionStoreState, TextPart } from "../../store/types";
import { generateTitle } from "../../title-generation";

export function createTitleGenerationTask(
  store: StoreApi<SessionStoreState>,
): BackgroundTask {
  return {
    name: "title-generation",

    run: async (ctx: BackgroundTaskContext) => {
      const state = store.getState();

      const firstUserMessage = state.messages.find((m) => m.role === "user");
      if (!firstUserMessage) return;

      const text = firstUserMessage.parts
        .filter((p): p is TextPart => p.type === "text")
        .map((p) => p.text)
        .join(" ")
        .trim();

      if (!text) return;

      try {
        const title = await generateTitle({
          kind: "session",
          text,
          modelInfo: ctx.modelInfo,
          modelOptions: ctx.modelOptions,
        });
        if (title !== null) store.getState().setTitle(title);
      } catch (err) {
        ctx.logger.warn("title.generation.failed", {
          error: err,
          context: { sessionId: state.sessionId },
        });
      }
    },
  };
}
