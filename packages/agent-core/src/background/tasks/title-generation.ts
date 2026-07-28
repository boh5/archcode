import type { StoreApi } from "zustand/vanilla";
import type { BackgroundTask, BackgroundTaskContext } from "../types";
import type { SessionStoreState } from "../../store/types";
import { renderAttachmentMarker } from "../../store/projection";
import { generateTitle } from "../../title-generation";

export function createTitleGenerationTask(
  store: StoreApi<SessionStoreState>,
): BackgroundTask {
  return {
    name: "title-generation",

    run: async (ctx: BackgroundTaskContext) => {
      const state = store.getState();

      const text = state.messages
        .filter((message) => message.role === "user")
        .map((message) => message.parts
          .flatMap((part) => {
            if (part.type === "text") return [part.text];
            if (part.type === "attachment") return [renderAttachmentMarker(part.attachment)];
            return [];
          })
          .join(" ")
          .trim())
        .find((messageText) => messageText.length > 0);

      if (!text) return;

      try {
        const title = await generateTitle({
          kind: "session",
          text,
          binding: ctx.binding,
          retryScheduler: ctx.retryScheduler,
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
