import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TOOL_GOAL_EVIDENCE, type DoneCondition, type DoneResult, type GoalSpecComplianceCriterionEvidence } from "@archcode/protocol";

import { goalEvidenceTool } from "../tools/builtins/goal-tools";
import { createRegistry } from "../tools/registry";
import { createTestProjectContext } from "../tools/test-project-context";
import { createToolExecutionContext } from "../tools/types";
import { SkillService } from "../skills";
import { createMockStore } from "../store/test-helpers";
import { storeManager } from "../store/store";
import { GoalStateManager } from "./state";
import { evaluateCondition } from "./done-checker";
import { GoalRunner } from "./runner";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "done-checker");
const testSkillService = new SkillService({ builtinSkills: {} });

let workspaceRoot = "";

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

function expectResult(result: DoneResult, conditionId: string, passed: boolean): void {
  expect(result.conditionId).toBe(conditionId);
  expect(result.passed).toBe(passed);
  expect(result.evidence.length).toBeGreaterThan(0);
  expect(Date.parse(result.checkedAt)).toBeGreaterThan(0);
}

function specComplianceFixture(): string {
  return [
    "# Spec",
    "- AC-001: CLI records reviewer evidence status: satisfied; evidence: reviewer artifact confirms evidence persisted; file: packages/agent-core/src/goals/done-checker.ts",
    "- AC-002: Repair context references failed criterion status: failed; evidence: structured summary says RAW_MODEL_PRIVATE_TEXT must not persist; repair: update repair context so AC-002 is actionable; file: packages/agent-core/src/goals/runner.ts; command: bun test packages/agent-core/src/goals/done-checker.test.ts -t \"spec compliance\"; result: focused spec compliance test failed",
    "- AC-003: Raw private output is excluded status: satisfied; evidence: persisted state contains summaries only; file: packages/protocol/src/types.ts",
    "",
  ].join("\n");
}

function findCriterion(criteria: GoalSpecComplianceCriterionEvidence[], criterionId: string): GoalSpecComplianceCriterionEvidence {
  const criterion = criteria.find((candidate) => candidate.criterionId === criterionId);
  if (!criterion) throw new Error(`Missing criterion ${criterionId}`);
  return criterion;
}

describe("evaluateCondition", () => {
  it("passes tests_pass when the configured command exits zero", async () => {
    const condition: DoneCondition = { id: "tests-ok", kind: "tests_pass", params: { command: "pwd" } };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "tests-ok", true);
    expect(result.evidence).toContain("EXIT_CODE: 0");
  });

  it("fails tests_pass when the configured command exits nonzero", async () => {
    const condition: DoneCondition = { id: "tests-fail", kind: "tests_pass", params: { command: "bun run definitely-missing-script" } };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "tests-fail", false);
    expect(result.evidence).toContain("EXIT_CODE: 1");
  });

  it("passes typecheck_pass when the configured command exits zero", async () => {
    const condition: DoneCondition = { id: "typecheck-ok", kind: "typecheck_pass", params: { command: "pwd" } };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "typecheck-ok", true);
    expect(result.evidence).toContain("EXIT_CODE: 0");
  });

  it("fails typecheck_pass when the configured command exits nonzero", async () => {
    const condition: DoneCondition = { id: "typecheck-fail", kind: "typecheck_pass", params: { command: "bun run definitely-missing-script" } };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "typecheck-fail", false);
    expect(result.evidence).toContain("EXIT_CODE: 1");
  });

  it("passes lsp_clean when the target has no supported source files", async () => {
    const condition: DoneCondition = { id: "lsp-ok", kind: "lsp_clean", params: { paths: ["."] } };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "lsp-ok", true);
    expect(result.evidence).toContain("0 diagnostics");
  });

  it("fails lsp_clean when a requested path cannot be accessed", async () => {
    const condition: DoneCondition = { id: "lsp-fail", kind: "lsp_clean", params: { paths: ["missing.ts"] } };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "lsp-fail", false);
    expect(result.evidence).toContain("missing.ts");
  });

  it("passes file_exists when the file exists", async () => {
    await writeFile(join(workspaceRoot, "present.txt"), "ok\n");
    const condition: DoneCondition = { id: "file-ok", kind: "file_exists", params: { path: "present.txt" } };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "file-ok", true);
    expect(result.evidence).toContain("exists=true");
  });

  it("fails file_exists when the file does not exist", async () => {
    const condition: DoneCondition = { id: "file-fail", kind: "file_exists", params: { path: "missing.txt" } };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "file-fail", false);
    expect(result.evidence).toContain("exists=false");
  });

  it("passes grep_contains when enough matches are present", async () => {
    await writeFile(join(workspaceRoot, "notes.txt"), "alpha\nbeta\nalpha again\n");
    const condition: DoneCondition = {
      id: "grep-contains-ok",
      kind: "grep_contains",
      params: { pattern: "alpha", path: "notes.txt", minMatches: 2 },
    };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "grep-contains-ok", true);
    expect(result.evidence).toContain("2 matches");
    expect(result.evidence).toContain("notes.txt:1");
  });

  it("fails grep_contains when too few matches are present", async () => {
    await writeFile(join(workspaceRoot, "notes.txt"), "alpha\nbeta\n");
    const condition: DoneCondition = {
      id: "grep-contains-fail",
      kind: "grep_contains",
      params: { pattern: "gamma", path: "notes.txt" },
    };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "grep-contains-fail", false);
    expect(result.evidence).toContain("0 matches");
  });

  it("passes grep_empty when no matches are present", async () => {
    await writeFile(join(workspaceRoot, "notes.txt"), "alpha\nbeta\n");
    const condition: DoneCondition = { id: "grep-empty-ok", kind: "grep_empty", params: { pattern: "gamma", path: "notes.txt" } };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "grep-empty-ok", true);
    expect(result.evidence).toContain("0 matches");
  });

  it("fails grep_empty when any match is present", async () => {
    await writeFile(join(workspaceRoot, "notes.txt"), "alpha\nbeta\n");
    const condition: DoneCondition = { id: "grep-empty-fail", kind: "grep_empty", params: { pattern: "alpha", path: "notes.txt" } };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "grep-empty-fail", false);
    expect(result.evidence).toContain("1 matches");
  });

  it("passes command_succeeds when the command exits zero", async () => {
    const condition: DoneCondition = { id: "command-ok", kind: "command_succeeds", params: { command: "pwd" } };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "command-ok", true);
    expect(result.evidence).toContain("EXIT_CODE: 0");
  });

  it("fails command_succeeds when the command exits nonzero", async () => {
    const condition: DoneCondition = { id: "command-fail", kind: "command_succeeds", params: { command: "bun run definitely-missing-script" } };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "command-fail", false);
    expect(result.evidence).toContain("EXIT_CODE: 1");
  });

  it("denies command_succeeds when bash policy denies the command", async () => {
    const condition: DoneCondition = { id: "command-denied", kind: "command_succeeds", params: { command: "rm -rf .archcode" } };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "command-denied", false);
    expect(result.evidence).toContain("Permission denied");
    expect(result.evidence).toContain("EXIT_CODE: 126");
  });

  it("requires confirmation for unknown command-bearing done conditions", async () => {
    const condition: DoneCondition = { id: "command-confirm", kind: "command_succeeds", params: { command: "bun --version" } };

    const denied = await evaluateCondition(condition, workspaceRoot);
    const approved = await evaluateCondition(condition, workspaceRoot, { confirmPermission: async () => "approve_once" });

    expectResult(denied, "command-confirm", false);
    expect(denied.evidence).toContain("EXIT_CODE: 126");
    expectResult(approved, "command-confirm", true);
    expect(approved.evidence).toContain("EXIT_CODE: 0");
  });

  it("returns the Phase 1 placeholder for user_confirmed", async () => {
    const condition: DoneCondition = { id: "user-ok", kind: "user_confirmed", params: { prompt: "Approve?" } };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "user-ok", true);
    expect(result.evidence).toBe("user_confirmed: awaiting HITL");
  });

  it("spec compliance records three per-criterion evidence summaries with satisfied and failed statuses", async () => {
    await writeFile(join(workspaceRoot, "SPEC.md"), specComplianceFixture());
    const condition: DoneCondition = { id: "spec-check", kind: "spec_compliance", params: { specPath: "SPEC.md" } };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "spec-check", false);
    expect(result.evidence).toContain("failed: AC-002");
    expect(result.specCompliance?.summary).toBe("1/3 acceptance criteria failed: AC-002.");
    expect(result.specCompliance?.criteria.map((criterion) => criterion.criterionId)).toEqual(["AC-001", "AC-002", "AC-003"]);
    expect(findCriterion(result.specCompliance?.criteria ?? [], "AC-001")).toMatchObject({ status: "satisfied", compliant: true });
    expect(findCriterion(result.specCompliance?.criteria ?? [], "AC-002")).toMatchObject({
      status: "failed",
      compliant: false,
      fileRefs: ["packages/agent-core/src/goals/runner.ts"],
      commandRefs: ["bun test packages/agent-core/src/goals/done-checker.test.ts -t \"spec compliance\""],
      resultRefs: ["focused spec compliance test failed"],
      repairGuidance: "update repair context so AC-002 is actionable",
    });
    expect(findCriterion(result.specCompliance?.criteria ?? [], "AC-003")).toMatchObject({ status: "satisfied", compliant: true });
    expect(JSON.stringify(result)).not.toContain("RAW_MODEL_PRIVATE_TEXT");
  });
});

describe("goal_evidence check_done tool", () => {
  it("evaluates a condition and persists through the guarded Reviewer boundary", async () => {
    await writeFile(join(workspaceRoot, "artifact.txt"), "done\n");
    const manager = new GoalStateManager(workspaceRoot);
    const goal = await manager.create(
      "test-project",
      "Check canonical done evidence",
      "reviewer",
      [{ id: "artifact-exists", kind: "file_exists", params: { path: "artifact.txt" } }],
      { maxRetries: 1, backoffMs: 100, escalateOnFailure: true },
      [],
    );
    await manager.lock(goal.id, "review-test");
    await manager.transitionStatus(goal.id, "running");
    await manager.updatePhase(goal.id, "review");
    const registry = createRegistry([goalEvidenceTool]);
    const store = createMockStore({
      sessionId: "review-session",
      agentName: "reviewer",
      sessionRole: "review",
      goalId: goal.id,
    });
    const input = { action: "check_done", goalId: goal.id, conditionId: "artifact-exists" };
    const ctx = createToolExecutionContext({
      store,
      storeManager,
      toolName: TOOL_GOAL_EVIDENCE,
      toolCallId: "goal-evidence-check-done-call",
      input,
      step: 1,
      abort: new AbortController().signal,
      startedAt: Date.now(),
      allowedTools: new Set([TOOL_GOAL_EVIDENCE]),
      agentName: store.getState().agentName,
      agentSkills: [],
      skillService: testSkillService,
      projectContext: createTestProjectContext(workspaceRoot),
    });

    const toolResult = await registry.execute({ toolName: TOOL_GOAL_EVIDENCE, toolCallId: "goal-evidence-check-done-call", input }, ctx);

    expect(toolResult.isError).toBe(false);
    const doneResult = JSON.parse(toolResult.output) as DoneResult;
    expectResult(doneResult, "artifact-exists", true);
    const persisted = await manager.read(goal.id);
    expect(persisted.status).toBe("verifying");
    expect(persisted.doneResults["artifact-exists"]).toEqual(doneResult);
  });

  it("spec compliance persists only structured summaries through reviewer-owned goal_evidence check_done", async () => {
    await writeFile(join(workspaceRoot, "SPEC.md"), specComplianceFixture());
    const manager = new GoalStateManager(workspaceRoot);
    const goal = await manager.create(
      "test-project",
      "Check spec compliance evidence",
      "reviewer",
      [{ id: "spec-check", kind: "spec_compliance", params: { specPath: "SPEC.md" } }],
      { maxRetries: 1, backoffMs: 100, escalateOnFailure: true },
      [],
    );
    await manager.lock(goal.id, "review-test");
    await manager.transitionStatus(goal.id, "running");
    await manager.updatePhase(goal.id, "review");
    const registry = createRegistry([goalEvidenceTool]);
    const store = createMockStore({
      sessionId: "review-session",
      agentName: "reviewer",
      sessionRole: "review",
      goalId: goal.id,
    });
    const input = { action: "check_done", goalId: goal.id, conditionId: "spec-check" };
    const ctx = createToolExecutionContext({
      store,
      storeManager,
      toolName: TOOL_GOAL_EVIDENCE,
      toolCallId: "goal-evidence-check-done-spec-call",
      input,
      step: 1,
      abort: new AbortController().signal,
      startedAt: Date.now(),
      allowedTools: new Set([TOOL_GOAL_EVIDENCE]),
      agentName: store.getState().agentName,
      agentSkills: [],
      skillService: testSkillService,
      projectContext: createTestProjectContext(workspaceRoot),
    });

    const toolResult = await registry.execute({ toolName: TOOL_GOAL_EVIDENCE, toolCallId: "goal-evidence-check-done-spec-call", input }, ctx);

    expect(toolResult.isError).toBe(false);
    const persisted = await manager.read(goal.id);
    const serialized = JSON.stringify(persisted);
    expect(persisted.doneResults["spec-check"]?.passed).toBe(false);
    expect(persisted.doneResults["spec-check"]?.specCompliance?.criteria).toHaveLength(3);
    expect(findCriterion(persisted.doneResults["spec-check"]?.specCompliance?.criteria ?? [], "AC-002").status).toBe("failed");
    expect(serialized).toContain("structured summary says [private text redacted] must not persist");
    expect(serialized).not.toContain("RAW_MODEL_PRIVATE_TEXT");
  });

  it("spec compliance partial failure drives NOT_DONE repair context that references AC-002", async () => {
    await writeFile(join(workspaceRoot, "SPEC.md"), specComplianceFixture());
    const manager = new GoalStateManager(workspaceRoot);
    const goal = await manager.create(
      "test-project",
      "Finalize spec compliance",
      "reviewer",
      [{ id: "spec-check", kind: "spec_compliance", params: { specPath: "SPEC.md" } }],
      { maxRetries: 1, backoffMs: 100, escalateOnFailure: true },
      [],
    );
    await manager.lock(goal.id, "review-test");
    await manager.transitionStatus(goal.id, "running");
    await manager.updatePhase(goal.id, "review");
    const runner = new GoalRunner({
      goalStateManager: manager,
      goalArtifacts: createTestProjectContext(workspaceRoot).goalArtifacts,
      workspaceRoot,
      hitlService: {
        create: async (input) => ({
          hitlId: crypto.randomUUID(),
          owner: input.owner,
          blockingKey: input.blockingKey,
          source: input.source,
          status: "pending",
          displayPayload: input.displayPayload,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        list: async () => [],
      },
      createSession: async () => "retry-session",
    });
    const result = await evaluateCondition(goal.doneConditions[0]!, workspaceRoot);
    await runner.recordReviewerDoneResult(goal.id, "spec-check", result);

    const failed = await runner.finalizeReviewerReview(goal.id, "NOT_DONE", { waitForBackoff: false });

    expect(failed.status).toBe("failed");
    expect(failed.reviewReport?.outcome).toBe("NOT_DONE");
    expect(failed.reviewReport?.criteria.map((criterion) => criterion.criterionId)).toEqual(["AC-001", "AC-002", "AC-003"]);
    expect(failed.reviewReport?.criteria.find((criterion) => criterion.criterionId === "AC-002")).toMatchObject({ status: "failed", compliant: false });
    expect(failed.repairContext?.issues).toHaveLength(1);
    expect(failed.repairContext?.issues[0]).toMatchObject({
      conditionId: "AC-002",
      repairGuidance: "update repair context so AC-002 is actionable",
      repairTarget: "packages/agent-core/src/goals/runner.ts",
    });
    expect(failed.lastError).toContain("AC-002");
  });

  it("spec compliance is not evaluated or recorded for a wrong caller before authorization", async () => {
    await writeFile(join(workspaceRoot, "SPEC.md"), specComplianceFixture());
    const manager = new GoalStateManager(workspaceRoot);
    const goal = await manager.create(
      "test-project",
      "Reject wrong spec compliance caller",
      "reviewer",
      [{ id: "spec-check", kind: "spec_compliance", params: { specPath: "SPEC.md" } }],
      { maxRetries: 1, backoffMs: 100, escalateOnFailure: true },
      [],
    );
    await manager.lock(goal.id, "review-test");
    await manager.transitionStatus(goal.id, "running");
    await manager.updatePhase(goal.id, "review");
    const registry = createRegistry([goalEvidenceTool]);
    const store = createMockStore({ agentName: "build", sessionRole: "review", goalId: goal.id });
    const input = { action: "check_done", goalId: goal.id, conditionId: "spec-check" };
    const ctx = createToolExecutionContext({
      store,
      storeManager,
      toolName: TOOL_GOAL_EVIDENCE,
      toolCallId: "goal-evidence-check-done-denied-spec-call",
      input,
      step: 1,
      abort: new AbortController().signal,
      startedAt: Date.now(),
      allowedTools: new Set([TOOL_GOAL_EVIDENCE]),
      agentName: store.getState().agentName,
      agentSkills: [],
      skillService: testSkillService,
      projectContext: createTestProjectContext(workspaceRoot),
    });

    const toolResult = await registry.execute({ toolName: TOOL_GOAL_EVIDENCE, toolCallId: "goal-evidence-check-done-denied-spec-call", input }, ctx);

    expect(toolResult.isError).toBe(true);
    expect(toolResult.output).toContain("GOAL_REVIEWER_REQUIRED");
    const persisted = await manager.read(goal.id);
    expect(persisted.doneResults).toEqual({});
    await rm(join(workspaceRoot, "SPEC.md"));
    const stillNotEvaluated = await readFile(join(workspaceRoot, ".archcode", "goals", goal.id, "goal.json"), "utf8");
    expect(stillNotEvaluated).not.toContain("AC-002");
  });
});
