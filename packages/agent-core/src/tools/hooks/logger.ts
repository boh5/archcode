import type { Logger } from "../../logger";
import type { AfterHook, ToolExecutionContext, ToolExecutionResult } from "../types";

export function createExecutionLogger(logger: Logger): AfterHook {
  return async function executionLoggerAfterHook(
    result: ToolExecutionResult,
    ctx: ToolExecutionContext,
  ): Promise<void> {
    const meta: Record<string, unknown> = {
      toolName: ctx.toolName,
      toolCallId: ctx.toolCallId,
      isError: result.isError,
      outputSize: result.output.length,
      ...(ctx.durationMs !== undefined ? { durationMs: ctx.durationMs } : {}),
      ...(ctx.step !== undefined ? { step: ctx.step } : {}),
      ...(ctx.permissionOutcome !== undefined ? { permissionOutcome: ctx.permissionOutcome } : {}),
    };

    logger.debug("tool.execute.completed", {
      context: {
        sessionId: ctx.store.getState().sessionId,
        agentName: ctx.agentName,
      },
      meta,
    });
  };
}
