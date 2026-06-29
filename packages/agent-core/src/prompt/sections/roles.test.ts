import { describe, expect, test } from "bun:test";
import { buildRoleSection } from "./roles";
import type { PromptContext } from "../types";
import { orchestratorAgentDefinition } from "../../agents/definitions/orchestrator";
import { foremanAgentDefinition } from "../../agents/definitions/foreman";
import { criticAgentDefinition } from "../../agents/definitions/critic";
import { builderAgentDefinition } from "../../agents/definitions/builder";
import { reviewerAgentDefinition } from "../../agents/definitions/reviewer";
import { productAgentDefinition } from "../../agents/definitions/product";
import { specAgentDefinition } from "../../agents/definitions/spec";
import { exploreAgentDefinition } from "../../agents/definitions/explore";
import { librarianAgentDefinition } from "../../agents/definitions/librarian";

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
    ["orchestrator", "## Workflow Role: Orchestrator"],
    ["product", "## Workflow Role: Product"],
    ["spec", "## Workflow Role: Spec"],
    ["critic", "## Workflow Role: Critic"],
    ["foreman", "## Workflow Role: Foreman"],
    ["builder", "## Workflow Role: Builder"],
    ["reviewer", "## Workflow Role: Reviewer"],
    ["librarian", "## Workflow Role: Librarian"],
    ["explorer", "## Workflow Role: Explorer"],
  ])("resolves %s rolePrompt to non-empty role content", (_name, heading) => {
    const result = buildRoleSection(makeCtx(heading));

    expect(result).toBeString();
    expect(result?.trim().length).toBeGreaterThan(0);
    expect(result).toContain(heading);
  });

  test("returns null when rolePrompt is absent", () => {
    expect(buildRoleSection(makeCtx(undefined))).toBeNull();
  });

  test("orchestrator role prompt contains explicit workflow stage flow", () => {
    const result = buildRoleSection(makeCtx(orchestratorAgentDefinition.rolePrompt));

    expect(result).toContain("## Workflow Role: Orchestrator");
    expect(result).toContain("workflow_create");
    expect(result).toContain("move idle -> product_drafting");
    expect(result).toContain("Product to write the PRD");
    expect(result).toContain("critic_prd_review");
    expect(result).toContain("Spec to write SPEC and TASKS");
    expect(result).toContain("critic_spec_review");
    expect(result).toContain("delegate Foreman");
    expect(result).toContain("final verification/reporting");
    expect(result).toContain('workflow_update_stage with status: "completed"');
  });

  test("orchestrator role prompt owns batched interaction clearance before PRD, SPEC, and Critic gates", () => {
    const result = buildRoleSection(makeCtx(orchestratorAgentDefinition.rolePrompt));

    expect(result).toContain("workflow_propose_interactions");
    expect(result).toContain("workflow_request_interactions");
    expect(result).toContain("Delegate→propose→ask→resume");
    expect(result).toContain("call workflow_request_interactions once per gate");
    expect(result).toContain("before PRD review, before SPEC review, and before accepting Critic approval");
    expect(result).toContain("Never advance out of a stage while workflow_read shows unresolved interactions for that stage");
    expect(result).toContain("Persisted resolvedInteractions clear answered interactions");
  });

  test("orchestrator routes Product, Spec, and Critic questions through interaction tools instead of direct ask_user", () => {
    const result = buildRoleSection(makeCtx(orchestratorAgentDefinition.rolePrompt));

    expect(result).toContain("Product, Spec, and Critic must propose questions with workflow_propose_interactions");
    expect(result).toContain("Do not use ask_user for Product/Spec/Critic planning questions");
    expect(result).toContain("Only Orchestrator uses workflow_request_interactions to ask the user for batched gate decisions");
  });

  test("orchestrator role prompt requires ask_user before Foreman", () => {
    const result = buildRoleSection(makeCtx(orchestratorAgentDefinition.rolePrompt));

    expect(result).toContain("call ask_user for explicit execution approval before Foreman");
    expect(result).toContain("Critic approval is a quality gate only, NOT user approval");
    expect(result).toContain("Never delegate Foreman automatically from Critic approval");
    expect(result).toContain("Never skip ask_user before Foreman");
    expect(result).toContain("If the user rejects or withholds execution approval");
    expect(result).toContain("do not enter foreman_executing");
  });

  test("foreman role prompt contains required TASKS.md execution terms", () => {
    const result = buildRoleSection(makeCtx(foremanAgentDefinition.rolePrompt));

    expect(result).toContain("TASKS.md");
    expect(result).toContain("artifact_read");
    expect(result).toContain("calculateReadyWave()");
    expect(result).toContain("Wave 1: T1, T2");
    expect(result).toContain("Dependencies: none");
    expect(result).toContain("Delegate every task in the ready wave in parallel");
    expect(result).toContain("workflow_task_check");
    expect(result?.toLowerCase()).toContain("reread");
  });

  test("critic role prompt contains fixed TASKS.md field names and criteria", () => {
    const result = buildRoleSection(makeCtx(criticAgentDefinition.rolePrompt));

    expect(result).toContain("Agent:");
    expect(result).toContain("Dependencies:");
    expect(result).toContain("Description:");
    expect(result).toContain("Acceptance:");
    expect(result).toContain("QA:");
    expect(result).toContain("Approval criteria");
    expect(result).toContain("Rejection criteria");
  });

  test.each([
    ["Product", productAgentDefinition.rolePrompt],
    ["Spec", specAgentDefinition.rolePrompt],
    ["Critic", criticAgentDefinition.rolePrompt],
  ])("%s prompt surfaces required interactions without direct ask_user", (_name, rolePrompt) => {
    const result = buildRoleSection(makeCtx(rolePrompt));

    expect(result).toContain("Required Interaction proposal contract");
    expect(result).toContain("workflow_propose_interactions");
    expect(result).toContain("decisionKey");
    expect(result).toContain("options");
    expect(result).toContain("at least 2 for decisions");
    expect(result).toContain("recommendedOption");
    expect(result).toContain("rationale");
    expect(result).not.toContain("blocking=true");
    expect(result).not.toContain("blocking=false");
    expect(result).toContain("After proposing interactions, you will be resumed with user answers");
    expect(result).toContain("Do NOT call ask_user directly");
  });

  test("critic prompt narrows user proposals to appropriate decision categories", () => {
    const result = buildRoleSection(makeCtx(criticAgentDefinition.rolePrompt));

    expect(result).toContain("product scope");
    expect(result).toContain("risk acceptance");
    expect(result).toContain("major tradeoffs");
    expect(result).toContain("unresolved ambiguity");
  });

  test("builder role prompt contains TDD instruction and verification order", () => {
    const result = buildRoleSection(makeCtx(builderAgentDefinition.rolePrompt));

    expect(result).toContain("TDD");
    expect(result).toContain("write failing or updated tests first");
    expect(result).toContain("implement second");
    expect(result).toContain("bun run typecheck, then bun test");
  });

  test("builder role prompt forbids workflow progress and stage updates", () => {
    const result = buildRoleSection(makeCtx(builderAgentDefinition.rolePrompt));

    expect(result).toContain("Receive exactly one top-level TASKS.md task context from Foreman");
    expect(result).toContain("must NOT call workflow_task_check");
    expect(result).toContain("Foreman owns TASKS.md progress tracking");
    expect(result).toContain("must NOT alter workflow stage/status");
    expect(result).toContain("Explore or Librarian at depth 3");
    expect(result).toContain("artifact_write for evidence and reports");
  });

  test.each([
    ["Foreman", foremanAgentDefinition.rolePrompt],
    ["Builder", builderAgentDefinition.rolePrompt],
  ])("%s prompt preserves autonomous coding after execution approval", (_name, rolePrompt) => {
    const result = buildRoleSection(makeCtx(rolePrompt));

    expect(result).toContain("Autonomous-by-default coding after approval");
    expect(result).toContain("Ask the user ONLY for permissions/security confirmations");
    expect(result).toContain("true unrecoverable blockers");
    expect(result).toContain("plan-marked ask-before-changing decisions");
    expect(result).toContain("Do NOT ask about normal implementation choices");
  });

  test.each([
    ["Explorer", exploreAgentDefinition.rolePrompt],
    ["Librarian", librarianAgentDefinition.rolePrompt],
  ])("%s prompt requires concise evidence for orchestration decisions", (_name, rolePrompt) => {
    const result = buildRoleSection(makeCtx(rolePrompt));

    expect(result).toContain("Research mandate");
    expect(result).toContain("When to research");
    expect(result).toContain("What to look for");
    expect(result).toContain("Concise evidence output");
    expect(result).toContain("Facts found");
    expect(result).toContain("Citations");
    expect(result).toContain("Unknowns");
  });

  test("reviewer role prompt is codebase read-only with writable evidence reports", () => {
    const result = buildRoleSection(makeCtx(reviewerAgentDefinition.rolePrompt));

    expect(result).toContain("codebase read-only");
    expect(result).toContain("no file_write, file_edit, or bash");
    expect(result).toContain("artifact_write for evidence and reports");
    expect(result).toContain("must NOT call workflow_task_check");
  });

  test("reviewer role prompt requires approval before Foreman checks completed tasks", () => {
    const result = buildRoleSection(makeCtx(reviewerAgentDefinition.rolePrompt));

    expect(result).toContain("Verify the delegated task's acceptance criteria and QA outputs, not the whole plan");
    expect(result).toContain("Reviewer approval is required before Foreman checks completed Builder tasks");
  });
});
