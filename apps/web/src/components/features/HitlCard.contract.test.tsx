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
    expect(source).toContain("Always allow");
  });

  test("does not repeat the Ask User request title above its question content", () => {
    const source = readFileSync(new URL("./HitlCard.tsx", import.meta.url), "utf8");
    expect(source).toContain('view.source.type === "tool_permission"');
    expect(source).toContain("<h4");
    expect(source).not.toContain("sourceLabel");
    expect(source).not.toContain('kind="needs_you"');
  });

  test("uses the workbench surface, focus, warning, and control contracts", () => {
    const source = readFileSync(new URL("./HitlCard.tsx", import.meta.url), "utf8");
    expect(source).toContain("rounded-sm border-y border-r border-border-subtle");
    expect(source).toContain("border-l-[3px] border-l-warning bg-bg-elevated");
    expect(source).toContain("outline-none transition-colors focus-visible:bg-warning-muted");
    expect(source).toContain('PRIMARY_ACTION_CLASS = "h-8 rounded-sm');
    expect(source).toContain('SECONDARY_ACTION_CLASS = "h-8 rounded-sm');
  });

  test("uses natural-height content with a vertical option list", () => {
    const source = readFileSync(new URL("./HitlCard.tsx", import.meta.url), "utf8");
    expect(source).toContain('data-testid="hitl-decision-body"');
    expect(source).toContain('data-testid="hitl-decision-actions"');
    expect(source).toContain('data-testid="hitl-option-list"');
    expect(source).toContain("flex min-w-0 flex-col gap-1");
    expect(source).not.toContain("overflow-y-auto overscroll-contain");
    expect(source).not.toContain("auto-fit");
  });

  test("renders custom answers as a direct input without an extra disclosure click", () => {
    const source = readFileSync(new URL("./HitlCard.tsx", import.meta.url), "utf8");
    expect(source).toContain('placeholder={item.options?.length ? "Other answer…" : "Type your answer…"}');
    expect(source).not.toContain("customEntryOpen");
    expect(source).not.toContain("hitl-custom-answer-trigger");
  });
});
