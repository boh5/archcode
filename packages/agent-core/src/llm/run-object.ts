import { tool, zodSchema } from "ai";
import type { LlmObjectInput } from "./types";
import { LLM_OBJECT_SCHEMA_REPAIR_ATTEMPTS } from "./constants";
import { getLlmAdapter } from "./adapter";
import { LlmObjectError, LlmSchemaValidationError } from "./errors";
import { pickModelCallOptions } from "./options";
import { withLlmRetry } from "./retry";
import { silentLogger } from "../logger";
import { redactSensitiveValue } from "./provider-error-sanitizer";

export async function runLlmObject<T>(input: LlmObjectInput<T>): Promise<T> {
  const logger = input.logger ?? silentLogger;
  const toolName = input.schemaName ?? "result";
  const callOptions = pickModelCallOptions(input.modelOptions);
  const tools = {
    [toolName]: tool({
      inputSchema: zodSchema(input.schema),
      description: input.schemaDescription ?? "Submit the result as a JSON object matching the schema",
    }),
  };
  let lastSchemaError: LlmSchemaValidationError | undefined;

  for (let repairAttempt = 1; repairAttempt <= LLM_OBJECT_SCHEMA_REPAIR_ATTEMPTS; repairAttempt++) {
    const prompt = repairAttempt === 1 ? input.prompt : buildRepairPrompt(input.prompt, lastSchemaError);
    const result = await withLlmRetry(async () => getLlmAdapter().generateText({
      model: input.model,
      ...(input.system ? { system: input.system } : {}),
      prompt,
      abortSignal: input.abortSignal,
      tools,
      toolChoice: { type: "tool", toolName },
      ...callOptions,
    }), "LLM object generation", undefined, {
      abortSignal: input.abortSignal,
      retryScheduler: input.retryScheduler,
      redactSensitiveText: input.redactSensitiveText,
    });

    try {
      return parseObjectResult(
        redactSensitiveValue(result.toolCalls, input.redactSensitiveText),
        toolName,
        input.schema,
      );
    } catch (err) {
      if (!(err instanceof LlmSchemaValidationError)) throw err;
      lastSchemaError = err;
      logger.warn("llm.object.schema.repair", {
        context: { schema: input.schemaName, repairAttempt },
        error: { name: err.name, message: err.message },
      });
      if (repairAttempt >= LLM_OBJECT_SCHEMA_REPAIR_ATTEMPTS) throw err;
    }
  }

  throw lastSchemaError ?? new LlmObjectError({ message: "Model did not produce a schema-valid object" });
}

function parseObjectResult<T>(toolCalls: Array<{ toolName: string; input: unknown }>, toolName: string, schema: LlmObjectInput<T>["schema"]): T {
  const toolCall = toolCalls.find((tc) => tc.toolName === toolName);
  if (!toolCall) {
    throw new LlmObjectError({ message: `Model did not call the ${toolName} tool` });
  }
  if (typeof toolCall.input !== "object" || toolCall.input === null) {
    throw new LlmObjectError({ message: "Tool call input is not an object" });
  }

  try {
    return schema.parse(toolCall.input);
  } catch (err) {
    throw new LlmSchemaValidationError({
      message: err instanceof Error ? err.message : "Schema validation failed",
      cause: err instanceof Error ? err : undefined,
    });
  }
}

function buildRepairPrompt(prompt: string, err: LlmSchemaValidationError | undefined): string {
  return `${prompt}\n\nThe previous result did not match the required schema. Return a corrected tool call only. Validation error: ${err?.message ?? "unknown schema error"}`;
}
