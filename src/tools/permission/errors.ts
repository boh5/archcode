import type { PermissionErrorCode, ToolExecutionResult } from "../types";
import type { ToolErrorKind } from "../errors";
import { createToolErrorResult, kindFromCode } from "../errors";

export function createPermissionErrorResult(
  code: PermissionErrorCode,
  message: string,
  meta?: Record<string, unknown>,
  kindOverride?: ToolErrorKind,
): ToolExecutionResult {
  return createToolErrorResult({
    kind: kindOverride ?? kindFromCode(code) ?? "permission-denied",
    code,
    message,
    meta: {
      permissionErrorCode: code,
      skippedExecution: true,
      ...meta,
    },
  });
}
