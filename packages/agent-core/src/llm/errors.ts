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
 * Thrown when Specra-managed retry handling exhausts all attempts.
 */
export class LlmMaxRetriesError extends Error {
  public readonly cause: Error | undefined;
  public readonly attempts: number;
  public readonly retryable: boolean;

  constructor(
    { message, cause, attempts, retryable }: { message: string; cause?: Error; attempts?: number; retryable?: boolean },
  ) {
    super(message);
    this.name = "LlmMaxRetriesError";
    this.cause = cause;
    this.attempts = attempts ?? 0;
    this.retryable = retryable ?? false;
  }
}
