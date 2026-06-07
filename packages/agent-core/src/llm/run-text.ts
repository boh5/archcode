import { getLlmAdapter } from "./adapter";
import { pickModelCallOptions } from "./options";
import type { LlmTextInput, LlmTextResult } from "./types";
import { withLlmRetry } from "./retry";

export async function runLlmText(input: LlmTextInput): Promise<LlmTextResult> {
  const promptInput = input.messages ? { messages: input.messages } : { prompt: input.prompt ?? "" };
  const callOptions = pickModelCallOptions(input.modelOptions);
  return withLlmRetry(async () => {
    const result = await getLlmAdapter().generateText({
      model: input.model,
      ...callOptions,
      ...(input.system ? { system: input.system } : {}),
      ...promptInput,
      abortSignal: input.abortSignal,
    });
    return { text: result.text };
  }, "LLM text generation", undefined, { abortSignal: input.abortSignal });
}
