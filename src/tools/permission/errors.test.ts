import { describe, expect, it } from "bun:test";
import type { PermissionErrorCode, ToolExecutionResult } from "../types";
import { createPermissionErrorResult } from "./errors";
import { TOOL_ERROR_META_KEY } from "../errors";

describe("createPermissionErrorResult", () => {
  function parseOutput(result: ToolExecutionResult): Record<string, unknown> {
    return JSON.parse(result.output) as Record<string, unknown>;
  }

  it("returns a ToolExecutionResult with output matching message", () => {
    const result = createPermissionErrorResult(
      "TOOL_PERMISSION_DENIED",
      "Tool 'rm' is not permitted",
    );
    expect(parseOutput(result).message).toBe("Tool 'rm' is not permitted");
    expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
  });

  it("sets isError to true", () => {
    const result = createPermissionErrorResult("TOOL_NOT_ALLOWED", "not allowed");
    expect(result.isError).toBe(true);
  });

  it("sets meta.permissionErrorCode to the given code", () => {
    const code: PermissionErrorCode = "TOOL_PERMISSION_CONFIRMATION_TIMEOUT";
    const result = createPermissionErrorResult(code, "confirmation timed out");
    expect(result.meta?.permissionErrorCode).toBe(code);
  });

  it("sets meta.skippedExecution to true", () => {
    const result = createPermissionErrorResult("TOOL_PERMISSION_DENIED", "denied");
    expect(result.meta?.skippedExecution).toBe(true);
  });

  it("uses a kind override when provided", () => {
    const result = createPermissionErrorResult(
      "TOOL_PERMISSION_DENIED",
      "outside workspace",
      undefined,
      "workspace",
    );
    expect(parseOutput(result).kind).toBe("workspace");
    expect(result.meta?.permissionErrorCode).toBe("TOOL_PERMISSION_DENIED");
  });

  it("passes through additional meta properties", () => {
    const result = createPermissionErrorResult(
      "TOOL_PERMISSION_DENIED",
      "denied",
      { toolName: "rm", reason: "policy violation" },
    );
    expect(result.meta?.toolName).toBe("rm");
    expect(result.meta?.reason).toBe("policy violation");
  });

  it("works with TOOL_PERMISSION_CONFIRMATION_UNAVAILABLE code", () => {
    const result = createPermissionErrorResult(
      "TOOL_PERMISSION_CONFIRMATION_UNAVAILABLE",
      "Cannot confirm: no interactive terminal available",
    );
    expect(parseOutput(result).message).toBe("Cannot confirm: no interactive terminal available");
    expect(result.isError).toBe(true);
    expect(result.meta?.permissionErrorCode).toBe("TOOL_PERMISSION_CONFIRMATION_UNAVAILABLE");
    expect(result.meta?.skippedExecution).toBe(true);
  });

  it("works with TOOL_UNKNOWN code", () => {
    const result = createPermissionErrorResult("TOOL_UNKNOWN", "Unknown tool 'xyz'");
    expect(parseOutput(result).message).toBe("Unknown tool 'xyz'");
    expect(result.isError).toBe(true);
    expect(result.meta?.permissionErrorCode).toBe("TOOL_UNKNOWN");
    expect(result.meta?.skippedExecution).toBe(true);
  });
});
