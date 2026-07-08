import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { GOAL_HITL_ACTION_ADVANCE_PHASE } from "@archcode/protocol";

import {
  GoalEmptyConditionsError,
  GoalInvalidIdError,
  GoalLockedError,
  GoalNotFoundError,
  GoalPathError,
  GoalStateError,
  GoalStateManager,
  GoalStateSchema,
  type DoneCondition,
  type RetryPolicy,
} from "./state";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "goal-state");
const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_LOOP_ID = "660e8400-e29b-41d4-a716-446655440001";

const condition: DoneCondition = {
  id: "tests",
  kind: "tests_pass",
  params: { command: "bun test" },
};

async function captureAsyncError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected async action to throw");
}

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("GoalStateSchema", () => {
  test("accepts goal state metadata and rejects unknown keys", () => {
    const now = new Date().toISOString();
    const state = GoalStateSchema.parse({
      id: VALID_UUID,
      projectId: "project-a",
      title: "Ship goal state",
      status: "draft",
      phase: "plan",
      doneConditions: [condition],
      doneResults: {},
      reviewerAgent: "reviewer",
      retryPolicy: { maxRetries: 2, backoffMs: 1000, escalateOnFailure: true },
      retryCount: 0,
      approvalPoints: ["after_plan"],
      author: "orchestrator",
      loopId: VALID_LOOP_ID,
      childSessionIds: [],
      attentionStatus: "waiting_for_human",
      blockedByHitlIds: ["hitl-1"],
      resumeCheckpoint: {
        version: 1,
        hitlId: "hitl-1",
        blockedAt: now,
        kind: "goal_approval",
        action: GOAL_HITL_ACTION_ADVANCE_PHASE,
        from: "plan",
        to: "build",
        approvalPoint: "after_plan",
        phase: "plan",
        reason: "approval required",
      },
      createdAt: now,
      updatedAt: now,
    });

    expect(state.id).toBe(VALID_UUID);
    expect(state.loopId).toBe(VALID_LOOP_ID);
    expect(state.attentionStatus).toBe("waiting_for_human");
    expect(state.resumeCheckpoint?.hitlId).toBe("hitl-1");
    expect(() => GoalStateSchema.parse({ ...state, workflowId: VALID_UUID })).toThrow();
  });

  test("normalizes legacy camelCase Goal HITL action names", () => {
    const now = new Date().toISOString();

    const state = GoalStateSchema.parse({
      id: VALID_UUID,
      projectId: "project-a",
      title: "Legacy checkpoint",
      status: "paused",
      phase: "plan",
      doneConditions: [condition],
      doneResults: {},
      reviewerAgent: "reviewer",
      retryPolicy: { maxRetries: 1, backoffMs: 0, escalateOnFailure: false },
      retryCount: 0,
      approvalPoints: ["after_plan"],
      author: "planner",
      childSessionIds: [],
      resumeCheckpoint: {
        version: 1,
        hitlId: "hitl-legacy",
        blockedAt: now,
        kind: "goal_approval",
        action: "advancePhase",
        from: "plan",
        to: "build",
        approvalPoint: "after_plan",
      },
      createdAt: now,
      updatedAt: now,
    });

    expect(state.resumeCheckpoint?.action).toBe(GOAL_HITL_ACTION_ADVANCE_PHASE);
  });

  test("validates all done condition variants with required default true", () => {
    const parsed = GoalStateSchema.parse({
      id: VALID_UUID,
      projectId: "project-a",
      title: "Variants",
      status: "draft",
      phase: "plan",
      doneConditions: [
        { id: "tests", kind: "tests_pass", params: { command: "bun test" } },
        { id: "typecheck", kind: "typecheck_pass", params: {} },
        { id: "lsp", kind: "lsp_clean", params: { paths: ["src"], severity: "warning" } },
        { id: "file", kind: "file_exists", params: { path: "README.md" } },
        { id: "contains", kind: "grep_contains", params: { pattern: "Goal", path: "src", minMatches: 1 } },
        { id: "empty", kind: "grep_empty", params: { pattern: "TODO", path: "src" } },
        { id: "command", kind: "command_succeeds", params: { command: "bun test", timeoutMs: 1000 } },
        { id: "user", kind: "user_confirmed", params: { prompt: "Approve?" } },
        { id: "spec", kind: "spec_compliance", params: { specPath: "SPEC.md", focusAreas: ["state"] }, required: false },
      ],
      doneResults: {},
      reviewerAgent: "reviewer",
      retryPolicy: { maxRetries: 1, backoffMs: 0, escalateOnFailure: false },
      retryCount: 0,
      approvalPoints: [],
      author: "planner",
      childSessionIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(parsed.doneConditions[0]?.required).toBe(true);
    expect(parsed.doneConditions[8]?.required).toBe(false);
    expect(() => GoalStateSchema.parse({
      ...parsed,
      doneConditions: [{ id: "bad", kind: "file_exists", params: { path: "x", extra: true } }],
    })).toThrow();
  });
});

describe("GoalStateManager", () => {
  test("create produces a draft goal with correct fields", async () => {
    const manager = new GoalStateManager(TMP_DIR);

    const created = await manager.create("project-a", "  My goal  ", "architect");

    expect(created).toMatchObject({
      projectId: "project-a",
      title: "My goal",
      status: "draft",
      phase: "plan",
      doneConditions: [],
      doneResults: {},
      reviewerAgent: "reviewer",
      retryPolicy: { maxRetries: 3, backoffMs: 1000, escalateOnFailure: true },
      retryCount: 0,
      approvalPoints: [],
      author: "architect",
      childSessionIds: [],
    });
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(existsSync(join(TMP_DIR, ".archcode", "goals", created.id, "goal.json"))).toBe(true);
  });

  test("read returns persisted goal", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await manager.create("project-a", "Read me", "architect", [condition]);

    expect(await manager.read(created.id)).toEqual(created);
  });

  test("listGoals filters by projectId", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const a1 = await manager.create("project-a", "A1", "architect");
    const b1 = await manager.create("project-b", "B1", "architect");
    const a2 = await manager.create("project-a", "A2", "architect");

    expect(new Set((await manager.listGoals("project-a")).map((goal) => goal.id))).toEqual(new Set([a1.id, a2.id]));
    expect(new Set((await manager.listGoals()).map((goal) => goal.id))).toEqual(new Set([a1.id, b1.id, a2.id]));
  });

  test("listGoals skips stale goal directories missing goal.json", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const valid = await manager.create("project-a", "Valid", "architect");
    const staleGoalId = "78878538-b50c-4357-b6b8-087b1683adb4";
    await mkdir(join(TMP_DIR, ".archcode", "goals", staleGoalId), { recursive: true });

    expect(await captureAsyncError(() => manager.read(staleGoalId))).toBeInstanceOf(GoalNotFoundError);
    expect((await manager.listGoals("project-a")).map((goal) => goal.id)).toEqual([valid.id]);
  });

  test("patch updates draft title, doneConditions, retryPolicy, and approvalPoints", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await manager.create("project-a", "Draft", "architect");
    const retryPolicy: RetryPolicy = { maxRetries: 5, backoffMs: 250, escalateOnFailure: false };

    const patched = await manager.patch(created.id, {
      title: "Patched",
      doneConditions: [condition],
      retryPolicy,
      approvalPoints: ["after_plan", "before_complete"],
    });

    expect(patched.title).toBe("Patched");
    expect(patched.doneConditions).toEqual([{ ...condition, required: true }]);
    expect(patched.retryPolicy).toEqual(retryPolicy);
    expect(patched.approvalPoints).toEqual(["after_plan", "before_complete"]);
    expect(await manager.read(created.id)).toEqual(patched);
  });

  test("patch after lock throws GoalLockedError", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await manager.create("project-a", "Lock", "architect", [condition]);
    await manager.lock(created.id, "user-1");

    expect(await captureAsyncError(() => manager.patch(created.id, { title: "Denied" }))).toBeInstanceOf(GoalLockedError);
  });

  test("lock rejects empty doneConditions", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await manager.create("project-a", "No conditions", "architect");

    expect(await captureAsyncError(() => manager.lock(created.id, "user-1"))).toBeInstanceOf(GoalEmptyConditionsError);
  });

  test("lock records lockedBy and lockedAt and transitions to locked", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await manager.create("project-a", "Lock", "architect", [condition]);

    const locked = await manager.lock(created.id, "user-1");

    expect(locked.status).toBe("locked");
    expect(locked.lockedBy).toBe("user-1");
    expect(typeof locked.lockedAt).toBe("string");
    expect(Date.parse(locked.lockedAt ?? "")).not.toBeNaN();
  });

  test("transitionStatus validates state machine", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await manager.create("project-a", "Transitions", "architect", [condition]);

    expect(await captureAsyncError(() => manager.transitionStatus(created.id, "running"))).toBeInstanceOf(GoalStateError);
    await manager.lock(created.id, "user-1");
    const running = await manager.transitionStatus(created.id, "running");
    expect(running.status).toBe("running");
    const verifying = await manager.transitionStatus(created.id, "verifying");
    expect(verifying.status).toBe("verifying");
    expect(await captureAsyncError(() => manager.transitionStatus(created.id, "reviewed"))).toBeInstanceOf(GoalStateError);
    await manager.recordDoneResult(created.id, "tests", {
      conditionId: "tests",
      passed: true,
      evidence: "passed",
      checkedAt: new Date().toISOString(),
    });
    expect((await manager.transitionStatus(created.id, "reviewed")).status).toBe("reviewed");
    expect((await manager.transitionStatus(created.id, "completed")).status).toBe("completed");
  });

  test("transitionStatus only pauses resumable non-terminal states", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const draft = await manager.create("project-a", "Draft pause", "architect", [condition]);

    expect(await captureAsyncError(() => manager.transitionStatus(draft.id, "paused"))).toBeInstanceOf(GoalStateError);
    await manager.lock(draft.id, "user-1");
    expect((await manager.transitionStatus(draft.id, "paused")).status).toBe("paused");

    const failed = await manager.create("project-a", "Failed pause", "architect", [condition]);
    await manager.lock(failed.id, "user-1");
    await manager.transitionStatus(failed.id, "running");
    await manager.transitionStatus(failed.id, "failed");

    expect(await captureAsyncError(() => manager.transitionStatus(failed.id, "paused"))).toBeInstanceOf(GoalStateError);
  });

  test("updatePhase changes phase", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await manager.create("project-a", "Phase", "architect");

    expect((await manager.updatePhase(created.id, "build")).phase).toBe("build");
  });

  test("recordDoneResult stores result by conditionId", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await manager.create("project-a", "Result", "architect", [condition]);
    const result = { conditionId: "tests", passed: true, evidence: "ok", checkedAt: new Date().toISOString() };

    const updated = await manager.recordDoneResult(created.id, "tests", result);

    expect(updated.doneResults.tests).toEqual(result);
  });

  test("incrementRetryCount increments", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await manager.create("project-a", "Retry", "architect");

    expect((await manager.incrementRetryCount(created.id)).retryCount).toBe(1);
  });

  test("updateLastError stores error", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await manager.create("project-a", "Error", "architect");

    expect((await manager.updateLastError(created.id, "failed tests")).lastError).toBe("failed tests");
  });

  test("updateTokenBudget overwrites the persisted token budget", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await manager.create("project-a", "Budget", "architect");
    const firstBudget = {
      status: "ok" as const,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 1,
      cachedInputTokens: 2,
      totalTokens: 15,
      updatedAt: new Date().toISOString(),
    };
    const secondBudget = {
      ...firstBudget,
      status: "warning" as const,
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    };

    await manager.updateTokenBudget(created.id, firstBudget);
    const updated = await manager.updateTokenBudget(created.id, secondBudget);

    expect(updated.tokenBudget).toEqual(secondBudget);
    expect((await manager.read(created.id)).tokenBudget).toEqual(secondBudget);
  });

  test("updateSessionIds updates mainSessionId and childSessionIds", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await manager.create("project-a", "Sessions", "architect");

    const updated = await manager.updateSessionIds(created.id, "main-session", ["plan-session", "build-session"]);

    expect(updated.mainSessionId).toBe("main-session");
    expect(updated.childSessionIds).toEqual(["plan-session", "build-session"]);
  });

  test("atomic write produces valid JSON and no temp files", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await manager.create("project-a", "JSON", "architect", [condition]);
    await manager.lock(created.id, "user-1");

    const goalDir = join(TMP_DIR, ".archcode", "goals", created.id);
    const content = await Bun.file(join(goalDir, "goal.json")).text();
    expect(JSON.parse(content).id).toBe(created.id);
    expect((await readdir(goalDir)).filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
  });

  test("goalHitlPath resolves owner-local hitl.json", async () => {
    const manager = new GoalStateManager(TMP_DIR);

    await manager.create("project-a", "HITL", "architect");

    expect(await manager.goalHitlPath(VALID_UUID)).toBe(
      join(TMP_DIR, ".archcode", "goals", VALID_UUID, "hitl.json"),
    );
  });

  test("path traversal attempt rejected", async () => {
    const manager = new GoalStateManager(TMP_DIR);

    expect(await captureAsyncError(() => manager.read("../escape"))).toBeInstanceOf(GoalInvalidIdError);
    expect(await captureAsyncError(() => manager.goalHitlPath("../escape"))).toBeInstanceOf(GoalInvalidIdError);
    expect(await captureAsyncError(() => manager.read(VALID_UUID))).toBeInstanceOf(GoalNotFoundError);
    // Exercise the containment guard directly for corrupted caller paths that bypass UUID validation.
    expect(await captureAsyncError(() => manager.resolveContainedPathForTest("../escape/goal.json"))).toBeInstanceOf(GoalPathError);
  });

  test("read non-existent goal throws GoalNotFoundError", async () => {
    const manager = new GoalStateManager(TMP_DIR);

    expect(await captureAsyncError(() => manager.read(VALID_UUID))).toBeInstanceOf(GoalNotFoundError);
  });
});
