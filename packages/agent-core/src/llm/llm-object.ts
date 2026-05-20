import { generateText as aiGenerateText, tool, zodSchema } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LlmObjectInput } from "./types";
import { LlmObjectError, LlmSchemaValidationError } from "./errors";

let _generateText: typeof aiGenerateText = aiGenerateText;

export function __setGenerateTextForTest(fn: typeof aiGenerateText) {
  _generateText = fn;
}

export async function llmObject<T>(input: LlmObjectInput<T>): Promise<T> {
  const {
    model,
    schema,
    system,
    prompt,
    abortSignal,
    modelOptions,
    schemaName,
    schemaDescription,
  } = input;
  const toolName = schemaName ?? "result";

  const generateTextOptions = {
    ...(modelOptions?.maxOutputTokens !== undefined
      ? { maxOutputTokens: modelOptions.maxOutputTokens }
      : {}),
    ...(modelOptions?.temperature !== undefined
      ? { temperature: modelOptions.temperature }
      : {}),
    ...(modelOptions?.topP !== undefined ? { topP: modelOptions.topP } : {}),
    ...(modelOptions?.topK !== undefined ? { topK: modelOptions.topK } : {}),
    ...(modelOptions?.presencePenalty !== undefined
      ? { presencePenalty: modelOptions.presencePenalty }
      : {}),
    ...(modelOptions?.frequencyPenalty !== undefined
      ? { frequencyPenalty: modelOptions.frequencyPenalty }
      : {}),
    ...(modelOptions?.stopSequences !== undefined
      ? { stopSequences: modelOptions.stopSequences }
      : {}),
    ...(modelOptions?.seed !== undefined ? { seed: modelOptions.seed } : {}),
    ...(modelOptions?.maxRetries !== undefined
      ? { maxRetries: modelOptions.maxRetries }
      : {}),
    ...(modelOptions?.timeout !== undefined ? { timeout: modelOptions.timeout } : {}),
    ...(modelOptions?.providerOptions !== undefined
      ? { providerOptions: modelOptions.providerOptions as ProviderOptions }
      : {}),
  };

  let result;
  try {
    result = await _generateText({
      model,
      system,
      prompt,
      abortSignal,
      tools: {
        [toolName]: tool({
          inputSchema: zodSchema(schema),
          description:
            schemaDescription ??
            `Submit the result as a JSON object matching the schema`,
        }),
      },
      toolChoice: { type: "tool", toolName },
      ...generateTextOptions,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AI_TypeValidationError") {
      throw new LlmSchemaValidationError({
        message: err.message,
        cause: err,
      });
    }
    throw err;
  }

  const toolCall = result.toolCalls.find(
    (tc) => tc.toolName === toolName,
  );
  if (!toolCall) {
    throw new LlmObjectError({
      message: `Model did not call the ${toolName} tool`,
    });
  }

  const toolInput = toolCall.input;
  if (typeof toolInput !== "object" || toolInput === null) {
    throw new LlmObjectError({
      message: "Tool call input is not an object",
    });
  }

  try {
    return schema.parse(toolInput);
  } catch (err) {
    throw new LlmSchemaValidationError({
      message: err instanceof Error ? err.message : "Schema validation failed",
      cause: err instanceof Error ? err : undefined,
    });
  }
}
