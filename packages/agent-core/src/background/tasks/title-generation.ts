import type { StoreApi } from "zustand/vanilla";
import type { BackgroundTask, BackgroundTaskContext } from "../types";
import type { SessionStoreState, TextPart } from "../../store/types";
import { runLlmText } from "../../llm";

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
        const result = await runLlmText({
          model: ctx.modelInfo.model,
          prompt: `Generate a concise session title (3-8 words) based on this user message: ${text}`,
          modelOptions: ctx.modelOptions,
        });
        const title = result.text.trim().replace(/^["']|["']$/g, "").slice(0, 50);

        store.getState().setTitle(title);
      } catch (err) {
        ctx.logger.warn("title.generation.failed", {
          error: err,
          context: { sessionId: state.sessionId },
        });
      }
    },
  };
}
