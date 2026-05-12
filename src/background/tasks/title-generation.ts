import { generateText as aiGenerateText } from "ai";
import type { StoreApi } from "zustand/vanilla";
import type { BackgroundTask, BackgroundTaskContext } from "../types";
import type { Registry } from "../../provider/index";
import type { SessionStoreState, TextPart } from "../../store/types";
import { saveSessionTranscript } from "../../store/helpers";

let _generateText: typeof aiGenerateText = aiGenerateText;

export function __setGenerateTextForTest(fn: typeof aiGenerateText) {
  _generateText = fn;
}

export function createTitleGenerationTask(
  store: StoreApi<SessionStoreState>,
  providerRegistry: Registry,
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
        const modelId = providerRegistry.modelIds[0];
        const modelInfo = providerRegistry.getModel(modelId);

        const result = await _generateText({
          model: modelInfo.model,
          prompt: `Generate a concise session title (3-8 words) based on this user message: ${text}`,
        });
        const title = result.text.trim().replace(/^["']|["']$/g, "").slice(0, 50);

        store.setState({ title });

        const updatedState = store.getState();
        const sessionsDir = ctx.sessionsDir;
        await saveSessionTranscript(
          {
            sessionId: updatedState.sessionId,
            createdAt: updatedState.createdAt,
            title: updatedState.title,
            messages: updatedState.messages,
            steps: updatedState.steps,
            todos: updatedState.todos,
          },
          sessionsDir,
        );
      } catch (err) {
        console.warn(
          "Title generation failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  };
}
