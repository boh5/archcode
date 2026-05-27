import { createConsoleLogger, type Logger } from "../../logger";
import type { AfterHook, ToolExecutionContext, ToolExecutionResult } from "../types";

const defaultLogger = createConsoleLogger({ module: "tools" });

export function createExecutionLogger(logger?: Logger): AfterHook {
  const log = logger ?? defaultLogger;

  return async function executionLoggerAfterHook(
    result: ToolExecutionResult,
    ctx: ToolExecutionContext,
  ): Promise<void> {
    const context: Record<string, unknown> = {
      toolName: ctx.toolName,
      toolCallId: ctx.toolCallId,
      input: ctx.redactedInput,
      isError: result.isError,
      outputSize: result.output.length,
      durationMs: ctx.durationMs,
    };

    log.debug("Tool execution completed", { context });
  };
}
