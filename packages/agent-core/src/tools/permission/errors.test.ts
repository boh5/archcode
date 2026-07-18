import { describe, expect, it } from "bun:test";
import type { PermissionErrorCode, RawToolResult } from "../types";
import { createPermissionErrorResult } from "./errors";

describe("createPermissionErrorResult", () => {
  function parseOutput(result: RawToolResult): Record<string, unknown> {
    if (result.draft.kind !== "text") throw new Error("Expected text draft");
    return JSON.parse(result.draft.text) as Record<string, unknown>;
  }

  it("returns a strict raw result with output matching message", () => {
    const result = createPermissionErrorResult(
      "TOOL_PERMISSION_DENIED",
      "Tool 'rm' is not permitted",
    );
    expect(parseOutput(result).message).toBe("Tool 'rm' is not permitted");
    expect(result.details?.error).toMatchObject({ code: "TOOL_PERMISSION_DENIED" });
  });

  it("sets isError to true", () => {
    const result = createPermissionErrorResult("TOOL_NOT_ALLOWED", "not allowed");
    expect(result.isError).toBe(true);
  });

  it("sets the strict error code to the given code", () => {
    const code: PermissionErrorCode = "TOOL_PERMISSION_CONFIRMATION_TIMEOUT";
    const result = createPermissionErrorResult(code, "confirmation timed out");
    expect(result.details?.error?.code).toBe(code);
  });

  it("classifies denied permission results", () => {
    const result = createPermissionErrorResult("TOOL_PERMISSION_DENIED", "denied");
    expect(result.details?.error?.kind).toBe("permission-denied");
  });

  it("uses a kind override when provided", () => {
    const result = createPermissionErrorResult(
      "TOOL_PERMISSION_DENIED",
      "outside workspace",
      "workspace",
    );
    expect(parseOutput(result).kind).toBe("workspace");
    expect(result.details?.error?.code).toBe("TOOL_PERMISSION_DENIED");
  });

  it("works with TOOL_PERMISSION_CONFIRMATION_UNAVAILABLE code", () => {
    const result = createPermissionErrorResult(
      "TOOL_PERMISSION_CONFIRMATION_UNAVAILABLE",
      "Cannot confirm: no interactive terminal available",
    );
    expect(parseOutput(result).message).toBe("Cannot confirm: no interactive terminal available");
    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_PERMISSION_CONFIRMATION_UNAVAILABLE");
  });

  it("works with TOOL_UNKNOWN code", () => {
    const result = createPermissionErrorResult("TOOL_UNKNOWN", "Unknown tool 'xyz'");
    expect(parseOutput(result).message).toBe("Unknown tool 'xyz'");
    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_UNKNOWN");
  });
});
