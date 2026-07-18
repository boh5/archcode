import type { PermissionErrorCode, RawToolResult } from "../types";
import type { ToolErrorKind } from "../errors";
import { createToolErrorResult, kindFromCode } from "../errors";

export function createPermissionErrorResult(
  code: PermissionErrorCode,
  message: string,
  kindOverride?: ToolErrorKind,
): RawToolResult {
  return createToolErrorResult({
    kind: kindOverride ?? kindFromCode(code) ?? "permission-denied",
    code,
    message,
  });
}
