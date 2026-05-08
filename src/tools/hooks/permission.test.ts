import { describe, expect, it } from "bun:test";
import type { GuardDecision, PermissionErrorCode, ToolExecutionResult } from "../types";
import { combineGuardDecisions, createPermissionErrorResult } from "./permission";

function decision(outcome: GuardDecision["outcome"], reason?: string): GuardDecision {
  return { outcome, reason };
}

describe("combineGuardDecisions", () => {
  it("returns allow for empty decisions", () => {
    const result = combineGuardDecisions([]);
    expect(result).toEqual({ outcome: "allow" });
  });

  it("returns allow when all decisions are allow", () => {
    const result = combineGuardDecisions([decision("allow"), decision("allow")]);
    expect(result).toEqual({ outcome: "allow" });
  });

  it("returns ask when decisions are allow + ask (priority: ask > allow)", () => {
    const result = combineGuardDecisions([decision("allow"), decision("ask", "needs confirmation")]);
    expect(result).toEqual({ outcome: "ask", reason: "needs confirmation" });
  });

  it("returns ask when decisions are ask + allow (order independent)", () => {
    const result = combineGuardDecisions([decision("ask", "check first"), decision("allow")]);
    expect(result).toEqual({ outcome: "ask", reason: "check first" });
  });

  it("returns deny when decisions are ask + deny (priority: deny > ask)", () => {
    const result = combineGuardDecisions([decision("ask"), decision("deny", "blocked by policy")]);
    expect(result).toEqual({ outcome: "deny", reason: "blocked by policy" });
  });

  it("returns deny when decisions are deny + ask (order independent)", () => {
    const result = combineGuardDecisions([decision("deny", "not allowed"), decision("ask")]);
    expect(result).toEqual({ outcome: "deny", reason: "not allowed" });
  });

  it("returns deny when decisions are deny + allow (priority: deny > allow)", () => {
    const result = combineGuardDecisions([decision("deny", "forbidden"), decision("allow")]);
    expect(result).toEqual({ outcome: "deny", reason: "forbidden" });
  });

  it("returns deny when any decision is deny (multiple items)", () => {
    const result = combineGuardDecisions([
      decision("allow"),
      decision("ask"),
      decision("deny", "final word"),
      decision("allow"),
    ]);
    expect(result).toEqual({ outcome: "deny", reason: "final word" });
  });

  it("picks the reason from the highest-priority decision", () => {
    const result = combineGuardDecisions([
      decision("allow"),
      decision("deny", "this is the reason"),
      decision("ask"),
    ]);
    expect(result).toEqual({ outcome: "deny", reason: "this is the reason" });
  });
});

describe("createPermissionErrorResult", () => {
  it("returns a ToolExecutionResult with output matching message", () => {
    const result = createPermissionErrorResult(
      "TOOL_PERMISSION_DENIED",
      "Tool 'rm' is not permitted",
    );
    expect(result.output).toBe("Tool 'rm' is not permitted");
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
    expect(result.output).toBe("Cannot confirm: no interactive terminal available");
    expect(result.isError).toBe(true);
    expect(result.meta?.permissionErrorCode).toBe("TOOL_PERMISSION_CONFIRMATION_UNAVAILABLE");
    expect(result.meta?.skippedExecution).toBe(true);
  });

  it("works with TOOL_UNKNOWN code", () => {
    const result = createPermissionErrorResult("TOOL_UNKNOWN", "Unknown tool 'xyz'");
    expect(result.output).toBe("Unknown tool 'xyz'");
    expect(result.isError).toBe(true);
    expect(result.meta?.permissionErrorCode).toBe("TOOL_UNKNOWN");
    expect(result.meta?.skippedExecution).toBe(true);
  });
});
