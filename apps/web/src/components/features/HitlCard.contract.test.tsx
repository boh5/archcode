import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { responseFor } from "./HitlCard";

describe("HITL card response contract", () => {
  test("maps question, permission, and budget sources to distinct responses", () => {
    expect(responseFor({ type: "ask_user", toolCallId: "q" }, ["yes"], "approved").type).toBe("question_answer");
    expect(responseFor({ type: "tool_permission", toolCallId: "p", toolName: "bash" }, [], "approve_once")).toEqual({ type: "permission_decision", decision: "approve_once", comment: undefined });
    expect(responseFor({ type: "goal_budget", approvalPoint: "before_build" }, [], "approved").type).toBe("budget_decision");
  });

  test("renders Always allow only for explicitly eligible permission views", () => {
    const source = readFileSync(new URL("./HitlCard.tsx", import.meta.url), "utf8");
    expect(source).toContain('view.persistentApprovalEligible === true');
    expect(source).toContain('submit("approve_always")');
  });
});
