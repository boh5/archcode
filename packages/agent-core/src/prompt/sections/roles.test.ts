import { describe, expect, test } from "bun:test";
import { buildRoleSection } from "./roles";
import type { PromptContext } from "../types";
import {
  buildAgentDefinition,
  exploreAgentDefinition,
  librarianAgentDefinition,
  orchestratorAgentDefinition,
  planAgentDefinition,
  reviewerAgentDefinition,
} from "../../agents/definitions";

function makeCtx(rolePrompt?: string): PromptContext {
  return {
    allowedTools: [],
    workspaceRoot: "/workspace",
    promptProfileId: "test",
    rolePrompt,
    env: {
      platform: "darwin",
      timezone: "America/Los_Angeles",
      locale: "en-US",
      cwd: "/workspace",
      date: "2026-05-18",
    },
  };
}

describe("buildRoleSection", () => {
  test.each([
    ["orchestrator", orchestratorAgentDefinition.rolePrompt, "## Goal Role: Orchestrator"],
    ["plan", planAgentDefinition.rolePrompt, "## Goal Role: Plan"],
    ["build", buildAgentDefinition.rolePrompt, "## Goal Role: Build"],
    ["reviewer", reviewerAgentDefinition.rolePrompt, "## Goal Role: Reviewer"],
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

  test("orchestrator role prompt describes Goal lifecycle and delegation boundaries", () => {
    const result = buildRoleSection(makeCtx(orchestratorAgentDefinition.rolePrompt));

    expect(result).toContain("goal_create");
    expect(result).toContain("goal_lock");
    expect(result).toContain("goal_run");
    expect(result).toContain("goal_check_done");
    expect(result).toContain("Tool sets are hardcoded by child agent definitions");
    expect(result).toContain("Plan handles requirements");
    expect(result).toContain("Build writes code");
    expect(result).toContain("Reviewer verifies");
    expect(result).not.toContain("workflow_create");
  });

  test("plan role prompt is read-only and produces execution guidance", () => {
    const result = buildRoleSection(makeCtx(planAgentDefinition.rolePrompt));

    expect(result).toContain("read-only");
    expect(result).toContain("implementation guidance");
    expect(result).toContain("scope, constraints, ordered steps, tests, and risk notes");
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

    expect(result).toContain("Default stance: NOT_DONE");
    for (const item of ["Scope", "Intent", "Tests", "No cheating", "Risk"] as const) {
      expect(result).toContain(item);
    }
    expect(result).toContain("DONE");
    expect(result).toContain("NOT_DONE");
    expect(result).not.toContain("ESCALATE_HUMAN");
    expect(result).toContain("goal_check_done");
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
