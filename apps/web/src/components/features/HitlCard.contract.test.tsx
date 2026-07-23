import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { responseFor } from "./HitlCard";

describe("HITL card response contract", () => {
  test("maps question and permission sources to their canonical responses", () => {
    expect(responseFor({ type: "ask_user", toolCallId: "q" }, ["yes"], "approved").type).toBe("question_answer");
    expect(responseFor({ type: "tool_permission", toolCallId: "p", toolName: "bash" }, [], "approve_once")).toEqual({ type: "permission_decision", decision: "approve_once", comment: undefined });
  });

  test("renders Always allow only for explicitly eligible permission views", () => {
    const source = readFileSync(new URL("./HitlCard.tsx", import.meta.url), "utf8");
    expect(source).toContain('view.persistentApprovalEligible === true');
    expect(source).toContain('submit("approve_always")');
  });

  test("keeps the HITL card authoritative while limiting attention motion to its glyph", () => {
    const source = readFileSync(new URL("./HitlCard.tsx", import.meta.url), "utf8");
    expect(source).toContain('kind="needs_you"');
    expect(source).toContain('previousStatus.current !== "pending"');
    expect(source).toContain('transition={attentionTransition ? "attention" : undefined}');
    expect(source).not.toContain("animate-pulse");
  });

  test("uses one warning decision field and control radius for every action", () => {
    const source = readFileSync(new URL("./HitlCard.tsx", import.meta.url), "utf8");
    expect(source).toContain('border-y border-r border-warning/40 border-l-[3px] border-l-warning bg-warning-muted');
    expect(source).toContain('PRIMARY_ACTION_CLASS = "h-8 rounded-sm');
    expect(source).toContain('SECONDARY_ACTION_CLASS = "h-8 rounded-sm');
    expect(source).not.toContain("rounded-lg border border-border-default border-l-2");
    expect(source).not.toContain("resize-y rounded-md");
  });
});
