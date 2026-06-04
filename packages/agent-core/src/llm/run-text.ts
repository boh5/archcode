import { getLlmAdapter } from "./adapter";
import { pickModelCallOptions } from "./options";
import type { LlmTextInput, LlmTextResult } from "./types";
import { withLlmRetry } from "./retry";

export async function runLlmText(input: LlmTextInput): Promise<LlmTextResult> {
  return withLlmRetry(async () => {
    const promptInput = input.messages ? { messages: input.messages } : { prompt: input.prompt ?? "" };
    const result = await getLlmAdapter().generateText({
      model: input.model,
      ...pickModelCallOptions(input.modelOptions),
      ...(input.system ? { system: input.system } : {}),
      ...promptInput,
      abortSignal: input.abortSignal,
    });
    return { text: result.text };
  }, "LLM text generation");
}
