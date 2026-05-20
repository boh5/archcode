import type { AfterHook, Logger, ToolExecutionContext, ToolExecutionResult } from "../types";

const defaultLogger: Logger = {
  debug: (message, meta) => console.debug(message, meta),
  info: (message, meta) => console.info(message, meta),
  warn: (message, meta) => console.warn(message, meta),
};

export function createExecutionLogger(logger?: Logger): AfterHook {
  const log = logger ?? defaultLogger;

  return async function executionLoggerAfterHook(
    result: ToolExecutionResult,
    ctx: ToolExecutionContext,
  ): Promise<void> {
    const meta: Record<string, unknown> = {
      toolName: ctx.toolName,
      toolCallId: ctx.toolCallId,
      input: ctx.redactedInput,
      isError: result.isError,
      outputSize: result.output.length,
      durationMs: ctx.durationMs,
    };

    if (typeof log.info === "function") {
      log.info("Tool execution completed", meta);
    }
  };
}
