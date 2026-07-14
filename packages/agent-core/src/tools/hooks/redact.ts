import type { AfterHook, ToolExecutionContext, ToolExecutionResult } from "../types";
import { redactString, redactValue, REDACTION_MARKER } from "../security";

export function createRedactionHook(): AfterHook {
  return async function redactionAfterHook(
    result: ToolExecutionResult,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    ctx.redactedInput = redactValue(ctx.redactedInput ?? ctx.input);

    return {
      ...result,
      output: redactString(result.output),
      isError: result.isError,
      meta: result.meta ? redactValue(result.meta) : result.meta,
      ...(result.blocked === undefined ? {} : { blocked: redactValue(result.blocked) }),
    };
  };
}
