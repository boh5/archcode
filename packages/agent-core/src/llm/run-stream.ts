import type { ToolSet } from "ai";
import { getLlmAdapter } from "./adapter";
import { pickModelCallOptions } from "./options";
import type { LlmStreamInput, LlmStreamResult } from "./types";

export function runLlmStream<TTools extends ToolSet = ToolSet>(input: LlmStreamInput<TTools>): LlmStreamResult<TTools> {
  return getLlmAdapter().streamText({
    model: input.model,
    ...pickModelCallOptions(input.modelOptions),
    messages: input.messages,
    abortSignal: input.abortSignal,
    // QueryLoop owns classification, redaction, persistence, and logging.
    // Suppress AI SDK's default raw Provider error logging at this boundary.
    onError: () => {},
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.system ? { system: input.system } : {}),
  }) as LlmStreamResult<TTools>;
}
