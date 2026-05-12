// ─── Error Classes ───

/**
 * Base error for llmObject failures.
 */
export class LlmObjectError extends Error {
  constructor(
    { message }: { message: string },
  ) {
    super(message);
    this.name = "LlmObjectError";
  }
}

/**
 * Thrown when LLM output fails Zod schema validation.
 */
export class LlmSchemaValidationError extends Error {
  public readonly cause: Error | undefined;

  constructor(
    { message, cause }: { message: string; cause?: Error },
  ) {
    super(message);
    this.name = "LlmSchemaValidationError";
    this.cause = cause;
  }
}

/**
 * Reserved for mapping AI SDK retry exhaustion once llmObject owns retry handling.
 * Today the AI SDK manages maxRetries internally and surfaces provider errors directly.
 */
export class LlmMaxRetriesError extends Error {
  public readonly cause: Error | undefined;

  constructor(
    { message, cause }: { message: string; cause?: Error },
  ) {
    super(message);
    this.name = "LlmMaxRetriesError";
    this.cause = cause;
  }
}
