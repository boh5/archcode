import { generateObject as aiGenerateObject } from "ai";
import type { StoreApi } from "zustand/vanilla";
import type { BackgroundTask, BackgroundTaskContext } from "../types";
import type { Registry } from "../../provider/index";
import type { SessionStoreState, TextPart } from "../../store/types";
import { TitleGenerationResultSchema } from "../../memory/schemas";
import { saveSessionTranscript } from "../../store/helpers";

let _generateObject: typeof aiGenerateObject = aiGenerateObject;

export function __setGenerateObjectForTest(fn: typeof aiGenerateObject) {
  _generateObject = fn;
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

        const { object } = await _generateObject({
          model: modelInfo.model,
          schema: TitleGenerationResultSchema,
          prompt: `Generate a concise session title (3-8 words) based on this user message: ${text}`,
        });

        store.setState({ title: object.title });

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
