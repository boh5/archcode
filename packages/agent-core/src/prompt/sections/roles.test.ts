import { describe, expect, test } from "bun:test";
import { buildRoleSection } from "./roles";
import type { PromptContext } from "../types";
import {
  buildAgentDefinition,
  exploreAgentDefinition,
  librarianAgentDefinition,
  engineerAgentDefinition,
  goalLeadAgentDefinition,
  planAgentDefinition,
  reviewerAgentDefinition,
} from "../../agents/definitions";

function makeCtx(rolePrompt?: string): PromptContext {
  return {
    allowedTools: [],
    promptProfileId: "test",
    rolePrompt,
    env: {
      platform: "darwin",
      timezone: "America/Los_Angeles",
      locale: "en-US",
      projectRoot: "/workspace",
      cwd: "/workspace",
      date: "2026-05-18",
    },
  };
}

const REMOVED_GOAL_EXECUTABLE_TOOL_NAMES = [
  "goal_lock",
  "goal_run",
  "goal_retry",
  "goal_check_done",
] as const;

describe("buildRoleSection", () => {
  test.each([
    ["engineer", engineerAgentDefinition.rolePrompt, "## Role: Engineer"],
    ["goal_lead", goalLeadAgentDefinition.rolePrompt, "## Goal Role: Goal Lead"],
    ["plan", planAgentDefinition.rolePrompt, "## Role: Plan"],
    ["build", buildAgentDefinition.rolePrompt, "## Role: Build"],
    ["reviewer", reviewerAgentDefinition.rolePrompt, "## Role: Reviewer"],
    ["explore", exploreAgentDefinition.rolePrompt, "## Goal Role: Explore"],
    ["librarian", librarianAgentDefinition.rolePrompt, "## Goal Role: Librarian"],
  ])("resolves %s rolePrompt to non-empty goal-era role content", (_name, rolePrompt, heading) => {
    const result = buildRoleSection(makeCtx(rolePrompt));

    expect(result).toBeString();
    expect(result?.trim().length).toBeGreaterThan(0);
    expect(result).toContain(heading);
    expect(result).not.toContain("## Workflow Role");
  });

  test("returns null when rolePrompt is absent", () => {
    expect(buildRoleSection(makeCtx(undefined))).toBeNull();
  });

  test.each([
    ["engineer", engineerAgentDefinition.rolePrompt],
    ["goal_lead", goalLeadAgentDefinition.rolePrompt],
    ["plan", planAgentDefinition.rolePrompt],
    ["build", buildAgentDefinition.rolePrompt],
    ["reviewer", reviewerAgentDefinition.rolePrompt],
    ["explore", exploreAgentDefinition.rolePrompt],
    ["librarian", librarianAgentDefinition.rolePrompt],
  ])("%s role prompt omits removed Goal executable names", (_name, rolePrompt) => {
    const result = buildRoleSection(makeCtx(rolePrompt));

    for (const toolName of REMOVED_GOAL_EXECUTABLE_TOOL_NAMES) {
      expect(result).not.toContain(toolName);
    }
  });

  test("Goal Lead role prompt describes Goal lifecycle and delegation boundaries", () => {
    const result = buildRoleSection(makeCtx(goalLeadAgentDefinition.rolePrompt));

    expect(result).toContain("goal_manage");
    expect(result).not.toContain("action=create");
    expect(result).not.toContain("action=start");
    expect(result).toContain("action=begin_review");
    expect(result).toContain("action=retry");
    expect(result).toContain("reviewGeneration");
    expect(result).toContain("action=retry before delegating");
    expect(result).toContain("Never leave a manually blocked Goal without a corresponding user request");
    expect(result).not.toContain("goal_create");
    expect(result).not.toContain("goal_lock");
    expect(result).not.toContain("goal_run");
    expect(result).not.toContain("goal_retry");
    expect(result).not.toContain("goal_check_done");
    expect(result).not.toContain("goal_manage.finalize_review");
    expect(result).not.toContain("finalize_review");
    expect(result).toContain("Tool sets are fixed by agent definitions");
    expect(result).toContain("Delegate all source implementation to Build");
    expect(result).toContain("Reviewer alone records DONE or NOT_DONE");
    expect(result).not.toContain("workflow_create");
  });

  test("plan role prompt is read-only and produces execution guidance", () => {
    const result = buildRoleSection(makeCtx(planAgentDefinition.rolePrompt));

    expect(result).toContain("read-only");
    expect(result).toContain("implementation guidance");
    expect(result).toContain("scope, constraints, ordered steps, tests, evidence refs, and risk notes");
  });

  test("build role prompt contains TDD instruction and verification evidence contract", () => {
    const result = buildRoleSection(makeCtx(buildAgentDefinition.rolePrompt));

    expect(result).toContain("TDD");
    expect(result).toContain("write failing or updated tests first");
    expect(result).toContain("implement second");
    expect(result).toContain("Report changed files, test commands, LSP/build/test results");
  });

  test("reviewer role prompt is default-deny with the five-point checklist", () => {
    const result = buildRoleSection(makeCtx(reviewerAgentDefinition.rolePrompt));

    expect(result).toContain("Goal-bound review, default stance: NOT_DONE");
    expect(result).toContain("Ordinary or Loop review");
    expect(result).toContain("Do not call goal_manage");
    for (const item of ["Scope", "Intent", "Tests", "No cheating", "Risk"] as const) {
      expect(result).toContain(item);
    }
    expect(result).toContain("DONE");
    expect(result).toContain("NOT_DONE");
    expect(result).not.toContain("ESCALATE_HUMAN");
    expect(result).toContain("goal_manage.finalize_review");
    expect(result).toContain("expectedReviewGeneration");
    expect(result).toContain("DONE requires evidence");
    expect(result).toContain("Insufficient evidence means NOT_DONE");
    expect(result).not.toContain("goal_check_done");
    expect(result).toContain("no file_write, file_edit, bash, or ast_grep_replace");
  });

  test.each([
    ["Explore", exploreAgentDefinition.rolePrompt],
    ["Librarian", librarianAgentDefinition.rolePrompt],
  ])("%s prompt requires concise evidence for parent decisions", (_name, rolePrompt) => {
    const result = buildRoleSection(makeCtx(rolePrompt));

    expect(result).toContain("Research mandate");
    expect(result).toContain("When to research");
    expect(result).toContain("What to look for");
    expect(result).toContain("Concise evidence output");
    expect(result).toContain("Facts found");
    expect(result).toContain("Citations");
    expect(result).toContain("Unknowns");
  });
});
