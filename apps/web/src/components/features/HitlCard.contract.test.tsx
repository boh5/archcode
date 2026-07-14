import { describe, expect, test } from "bun:test";
import { responseFor } from "./HitlCard";

describe("HITL card response contract", () => {
  test("maps question, permission, and budget sources to distinct responses", () => {
    expect(responseFor({ type: "ask_user", toolCallId: "q" }, ["yes"], "approved").type).toBe("question_answer");
    expect(responseFor({ type: "tool_permission", toolCallId: "p", toolName: "bash" }, [], "approve_once")).toEqual({ type: "permission_decision", decision: "approve_once", comment: undefined });
    expect(responseFor({ type: "goal_budget", approvalPoint: "before_build" }, [], "approved").type).toBe("budget_decision");
  });
});
