import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TOOL_GOAL_CHECK_DONE, type DoneCondition, type DoneResult } from "@archcode/protocol";

import { createGoalCheckDoneTool } from "../tools/builtins/goal-check-done";
import { createRegistry } from "../tools/registry";
import { createTestProjectContext } from "../tools/test-project-context";
import { createToolExecutionContext } from "../tools/types";
import { SkillService } from "../skills";
import { createMockStore } from "../store/test-helpers";
import { storeManager } from "../store/store";
import { GoalStateManager } from "./state";
import { evaluateCondition } from "./done-checker";

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

  it("returns an explicit unsupported result for spec_compliance", async () => {
    const condition: DoneCondition = { id: "spec-fail", kind: "spec_compliance", params: { specPath: "SPEC.md" } };

    const result = await evaluateCondition(condition, workspaceRoot);

    expectResult(result, "spec-fail", false);
    expect(result.evidence).toBe("spec_compliance is not implemented in Phase 1");
  });
});

describe("goal_check_done tool", () => {
  it("evaluates a condition and persists the result through GoalStateManager", async () => {
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
    const registry = createRegistry([createGoalCheckDoneTool()]);
    const store = createMockStore({ sessionId: "review-session" });
    const input = { goalId: goal.id, conditionId: "artifact-exists" };
    const ctx = createToolExecutionContext({
      store,
      storeManager,
      toolName: TOOL_GOAL_CHECK_DONE,
      toolCallId: "goal-check-done-call",
      input,
      step: 1,
      abort: new AbortController().signal,
      startedAt: Date.now(),
      allowedTools: new Set([TOOL_GOAL_CHECK_DONE]),
      agentName: store.getState().agentName,
      agentSkills: [],
      skillService: testSkillService,
      projectContext: createTestProjectContext(workspaceRoot),
    });

    const toolResult = await registry.execute({ toolName: TOOL_GOAL_CHECK_DONE, toolCallId: "goal-check-done-call", input }, ctx);

    expect(toolResult.isError).toBe(false);
    const doneResult = JSON.parse(toolResult.output) as DoneResult;
    expectResult(doneResult, "artifact-exists", true);
    const persisted = await manager.read(goal.id);
    expect(persisted.doneResults["artifact-exists"]).toEqual(doneResult);
  });
});
