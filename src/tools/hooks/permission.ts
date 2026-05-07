import type { BeforeHook, ToolExecutionContext } from "../types";

export function createPermissionGuard(): BeforeHook {
  return (_input: unknown, _ctx: ToolExecutionContext): void => {
    // v1 placeholder: no-op permission guard
  };
}
