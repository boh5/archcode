import type { Logger } from "../../logger";
import type { FinalizedToolResult } from "@archcode/protocol";
import type { FinalizedResultHook, ToolExecutionContext } from "../types";

export function createExecutionLogger(logger: Logger): FinalizedResultHook {
  return async function executionLoggerAfterHook(
    result: FinalizedToolResult,
    ctx: ToolExecutionContext,
  ): Promise<void> {
    const meta: Record<string, unknown> = {
      toolName: ctx.toolName,
      toolCallId: ctx.toolCallId,
      isError: result.isError,
      previewBytes: result.output.stored.bytes,
      canonicalBytes: result.output.canonical.bytes,
      completeness: result.output.completeness,
      recovery: result.output.recovery.kind,
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
