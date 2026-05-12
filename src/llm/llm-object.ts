import { generateText as aiGenerateText, tool, zodSchema } from "ai";
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
    schemaName,
    schemaDescription,
  } = input;
  const toolName = schemaName ?? "result";

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
