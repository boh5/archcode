import { describe, expect, it } from "bun:test";
import type { PermissionDecision } from "../types";
import { combinePermissionDecisions } from "./decision";

function decision(outcome: PermissionDecision["outcome"], reason?: string): PermissionDecision {
  return { outcome, reason };
}

describe("combinePermissionDecisions", () => {
  it("returns allow for empty decisions", () => {
    const result = combinePermissionDecisions([]);
    expect(result).toEqual({ outcome: "allow" });
  });

  it("returns allow when all decisions are allow", () => {
    const result = combinePermissionDecisions([decision("allow"), decision("allow")]);
    expect(result).toEqual({ outcome: "allow" });
  });

  it("returns ask when decisions are allow + ask (priority: ask > allow)", () => {
    const result = combinePermissionDecisions([decision("allow"), decision("ask", "needs confirmation")]);
    expect(result).toEqual({ outcome: "ask", reason: "needs confirmation" });
  });

  it("returns ask when decisions are ask + allow (order independent)", () => {
    const result = combinePermissionDecisions([decision("ask", "check first"), decision("allow")]);
    expect(result).toEqual({ outcome: "ask", reason: "check first" });
  });

  it("returns deny when decisions are ask + deny (priority: deny > ask)", () => {
    const result = combinePermissionDecisions([decision("ask"), decision("deny", "blocked by policy")]);
    expect(result).toEqual({ outcome: "deny", reason: "blocked by policy" });
  });

  it("returns deny when decisions are deny + ask (order independent)", () => {
    const result = combinePermissionDecisions([decision("deny", "not allowed"), decision("ask")]);
    expect(result).toEqual({ outcome: "deny", reason: "not allowed" });
  });

  it("returns deny when decisions are deny + allow (priority: deny > allow)", () => {
    const result = combinePermissionDecisions([decision("deny", "forbidden"), decision("allow")]);
    expect(result).toEqual({ outcome: "deny", reason: "forbidden" });
  });

  it("returns deny when any decision is deny (multiple items)", () => {
    const result = combinePermissionDecisions([
      decision("allow"),
      decision("ask"),
      decision("deny", "final word"),
      decision("allow"),
    ]);
    expect(result).toEqual({ outcome: "deny", reason: "final word" });
  });

  it("picks the reason from the highest-priority decision", () => {
    const result = combinePermissionDecisions([
      decision("allow"),
      decision("deny", "this is the reason"),
      decision("ask"),
    ]);
    expect(result).toEqual({ outcome: "deny", reason: "this is the reason" });
  });

  it("preserves errorKind and errorCode from a deny decision", () => {
    const result = combinePermissionDecisions([
      decision("allow"),
      {
        outcome: "deny",
        reason: "outside workspace",
        errorKind: "workspace",
        errorCode: "TOOL_FILE_OUTSIDE_WORKSPACE",
      },
    ]);
    expect(result).toEqual({
      outcome: "deny",
      reason: "outside workspace",
      errorKind: "workspace",
      errorCode: "TOOL_FILE_OUTSIDE_WORKSPACE",
    });
  });

  it("preserves errorKind and errorCode from an ask decision", () => {
    const result = combinePermissionDecisions([
      decision("allow"),
      {
        outcome: "ask",
        prompt: "confirm write",
        errorKind: "file-already-exists",
        errorCode: "TOOL_FILE_ALREADY_EXISTS",
      },
    ]);
    expect(result).toEqual({
      outcome: "ask",
      prompt: "confirm write",
      errorKind: "file-already-exists",
      errorCode: "TOOL_FILE_ALREADY_EXISTS",
    });
  });

  it("keeps deny as the winning decision when ask has no structured error fields", () => {
    const result = combinePermissionDecisions([
      decision("ask", "confirm first"),
      {
        outcome: "deny",
        reason: "must read before write",
        errorKind: "read-before-write",
        errorCode: "TOOL_FILE_NOT_READ_FIRST",
      },
    ]);
    expect(result).toEqual({
      outcome: "deny",
      reason: "must read before write",
      errorKind: "read-before-write",
      errorCode: "TOOL_FILE_NOT_READ_FIRST",
    });
  });
});
