import { generateText as aiGenerateText } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { StoreApi } from "zustand/vanilla";
import type { BackgroundTask, BackgroundTaskContext } from "../types";
import type { SessionStoreState, TextPart } from "../../store/types";
import { saveSessionTranscript } from "../../store/helpers";

let _generateText: typeof aiGenerateText = aiGenerateText;

export function __setGenerateTextForTest(fn: typeof aiGenerateText) {
  _generateText = fn;
}

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
        const result = await _generateText({
          model: ctx.modelInfo.model,
          prompt: `Generate a concise session title (3-8 words) based on this user message: ${text}`,
          ...(ctx.modelOptions?.maxOutputTokens !== undefined
            ? { maxOutputTokens: ctx.modelOptions.maxOutputTokens }
            : {}),
          ...(ctx.modelOptions?.temperature !== undefined
            ? { temperature: ctx.modelOptions.temperature }
            : {}),
          ...(ctx.modelOptions?.topP !== undefined
            ? { topP: ctx.modelOptions.topP }
            : {}),
          ...(ctx.modelOptions?.topK !== undefined
            ? { topK: ctx.modelOptions.topK }
            : {}),
          ...(ctx.modelOptions?.presencePenalty !== undefined
            ? { presencePenalty: ctx.modelOptions.presencePenalty }
            : {}),
          ...(ctx.modelOptions?.frequencyPenalty !== undefined
            ? { frequencyPenalty: ctx.modelOptions.frequencyPenalty }
            : {}),
          ...(ctx.modelOptions?.stopSequences !== undefined
            ? { stopSequences: ctx.modelOptions.stopSequences }
            : {}),
          ...(ctx.modelOptions?.seed !== undefined
            ? { seed: ctx.modelOptions.seed }
            : {}),
          ...(ctx.modelOptions?.maxRetries !== undefined
            ? { maxRetries: ctx.modelOptions.maxRetries }
            : {}),
          ...(ctx.modelOptions?.timeout !== undefined
            ? { timeout: ctx.modelOptions.timeout }
            : {}),
          ...(ctx.modelOptions?.providerOptions !== undefined
            ? { providerOptions: ctx.modelOptions.providerOptions as ProviderOptions }
            : {}),
        });
        const title = result.text.trim().replace(/^["']|["']$/g, "").slice(0, 50);

        store.setState({ title });

        const updatedState = store.getState();
        await saveSessionTranscript(
          {
            sessionId: updatedState.sessionId,
            createdAt: updatedState.createdAt,
            title: updatedState.title,
            messages: updatedState.messages,
            steps: updatedState.steps,
            todos: updatedState.todos,
          },
          ctx.workspaceRoot,
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
