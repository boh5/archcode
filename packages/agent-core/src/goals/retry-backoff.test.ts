import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { DoneCondition, DoneResult, GoalState } from "@archcode/protocol";
import { GoalArtifactManager } from "./artifacts";
import { GoalRunner } from "./runner";
import { GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-retry-backoff");
const BASE_TIME = Date.parse("2026-07-03T12:00:00.000Z");

const condition: DoneCondition = {
  id: "tests",
  kind: "tests_pass",
  params: { command: "bun test packages/agent-core/src/goals/retry-backoff.test.ts" },
};

let workspaceRoot = "";
let manager: GoalStateManager;
let artifacts: GoalArtifactManager;
let nowMs = BASE_TIME;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  manager = new GoalStateManager(workspaceRoot);
  artifacts = new GoalArtifactManager(workspaceRoot);
  nowMs = BASE_TIME;
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

function failingResult(): DoneResult {
  return {
    conditionId: condition.id,
    passed: false,
    evidence: "Tests failed before retry",
    checkedAt: new Date(nowMs).toISOString(),
  };
}

function createRunner(options: {
  sessionIds?: string[];
  retryDelay?: (ms: number, abort: AbortSignal) => Promise<void>;
} = {}): GoalRunner {
  const sessionIds = [...(options.sessionIds ?? ["main-session-1", "fresh-session-2", "fresh-session-3"])] as string[];
  return new GoalRunner({
    goalStateManager: manager,
    goalArtifacts: artifacts,
    workspaceRoot,
    hitlService: {
      create: mock(async (input) => ({
        hitlId: crypto.randomUUID(),
        owner: input.owner,
        blockingKey: input.blockingKey,
        source: input.source,
        status: "pending" as const,
        displayPayload: input.displayPayload,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      list: mock(async () => []),
    },
    createSession: mock(async () => sessionIds.shift() ?? `session-${crypto.randomUUID()}`),
    isSessionActive: mock(async () => false),
    now: () => new Date(nowMs),
    retryDelay: options.retryDelay,
  });
}

async function lockedGoal(maxRetries: number, backoffMs: number): Promise<GoalState> {
  const goal = await manager.create(
    "project-a",
    "Retry backoff goal",
    "architect",
    [condition],
    { maxRetries, backoffMs, escalateOnFailure: true },
    [],
  );
  return manager.lock(goal.id, "architect");
}

async function runToReview(goalId: string, runner: GoalRunner): Promise<void> {
  await runner.start(goalId);
  await runner.advancePhase(goalId, "build");
  await runner.advancePhase(goalId, "review");
}

describe("Goal retry backoff", () => {
  test("Reviewer NOT_DONE can explicitly schedule retry metadata without starting a fresh session early", async () => {
    const goal = await lockedGoal(2, 5_000);
    const runner = createRunner({ sessionIds: ["main-session-1", "fresh-session-2"] });
    await runToReview(goal.id, runner);
    await runner.recordReviewerDoneResult(goal.id, condition.id, failingResult());

    const scheduled = await runner.finalizeReviewerReview(goal.id, "NOT_DONE", {
      summary: "Tests are still failing",
      waitForBackoff: false,
    });

    expect(scheduled.status).toBe("failed");
    expect(scheduled.phase).toBe("review");
    expect(scheduled.retryCount).toBe(0);
    expect(scheduled.mainSessionId).toBe("main-session-1");
    expect(scheduled.repairContext?.summary).toContain("Reviewer NOT_DONE");
    expect(scheduled.retryState).toMatchObject({
      retryCount: 0,
      nextRetryAt: "2026-07-03T12:00:05.000Z",
      lastFailure: {
        errorKind: "review_not_done",
        message: "Reviewer NOT_DONE: required Done Conditions need repair (tests).",
        phase: "review",
      },
      lastAttempt: { attempt: 1, status: "scheduled", nextRetryAt: "2026-07-03T12:00:05.000Z" },
    });
    expect(await artifacts.readArtifact(goal.id, "retry-log.md")).toContain("| 1 | scheduled | Reviewer NOT_DONE: required Done Conditions need repair (tests). | none | 2026-07-03T12:00:05.000Z | not exhausted |");
  });

  test("Reviewer NOT_DONE waits for live backoff and starts a fresh retry in-process by default", async () => {
    const delayCalls: number[] = [];
    const goal = await lockedGoal(2, 5_000);
    const runner = createRunner({
      sessionIds: ["main-session-1", "fresh-session-2"],
      retryDelay: mock(async (ms: number, abort: AbortSignal) => {
        delayCalls.push(ms);
        expect(abort.aborted).toBe(false);
        nowMs += ms;
      }),
    });
    await runToReview(goal.id, runner);
    await runner.recordReviewerDoneResult(goal.id, condition.id, failingResult());

    const retry = await runner.finalizeReviewerReview(goal.id, "NOT_DONE", { summary: "Tests are still failing" });

    expect(delayCalls).toEqual([5_000]);
    expect(retry.status).toBe("running");
    expect(retry.phase).toBe("plan");
    expect(retry.retryCount).toBe(1);
    expect(retry.mainSessionId).toBe("fresh-session-2");
    expect(retry.childSessionIds).toEqual([]);
    expect(retry.repairContext?.summary).toContain("Reviewer NOT_DONE");
    expect(retry.retryState).toMatchObject({
      retryCount: 1,
      lastFailure: { message: "Reviewer NOT_DONE: required Done Conditions need repair (tests)." },
      lastAttempt: {
        attempt: 1,
        status: "running",
        scheduledAt: "2026-07-03T12:00:00.000Z",
        startedAt: "2026-07-03T12:00:05.000Z",
      },
    });
    const retryLog = await artifacts.readArtifact(goal.id, "retry-log.md");
    expect(retryLog).toContain("| 1 | scheduled | Reviewer NOT_DONE: required Done Conditions need repair (tests). | none | 2026-07-03T12:00:05.000Z | not exhausted |");
    expect(retryLog).toContain("| 1 | running | Reviewer NOT_DONE: required Done Conditions need repair (tests). | fresh-session-2 | not scheduled | not exhausted |");
  });

  test("due scan after manager and runner recreation starts one fresh retry and preserves repair context", async () => {
    const goal = await lockedGoal(2, 5_000);
    const runner = createRunner({ sessionIds: ["main-session-1"] });
    await runToReview(goal.id, runner);
    await runner.recordReviewerDoneResult(goal.id, condition.id, failingResult());
    await runner.finalizeReviewerReview(goal.id, "NOT_DONE", {
      summary: "Retry after backoff",
      waitForBackoff: false,
    });

    nowMs = BASE_TIME + 5_000;
    manager = new GoalStateManager(workspaceRoot);
    artifacts = new GoalArtifactManager(workspaceRoot);
    const recreated = createRunner({ sessionIds: ["fresh-session-2", "fresh-session-3"] });

    const recovered = await recreated.recoverDueScheduledRetries(workspaceRoot);
    const persisted = await manager.read(goal.id);

    expect(recovered).toHaveLength(1);
    expect(persisted.status).toBe("running");
    expect(persisted.phase).toBe("plan");
    expect(persisted.retryCount).toBe(1);
    expect(persisted.mainSessionId).toBe("fresh-session-2");
    expect(persisted.childSessionIds).toEqual([]);
    expect(persisted.repairContext?.summary).toContain("Reviewer NOT_DONE");
    expect(persisted.retryState).toMatchObject({
      retryCount: 1,
      lastAttempt: { attempt: 1, status: "running", startedAt: "2026-07-03T12:00:05.000Z" },
    });
  });

  test("abort during live backoff leaves scheduled retry unclaimed for later recovery", async () => {
    const controller = new AbortController();
    const delayCalls: number[] = [];
    const goal = await lockedGoal(1, 10_000);
    const runner = createRunner({
      sessionIds: ["main-session-1", "fresh-session-2"],
      retryDelay: mock(async (ms: number, abort: AbortSignal) => {
        delayCalls.push(ms);
        controller.abort();
        expect(abort.aborted).toBe(true);
      }),
    });
    await runToReview(goal.id, runner);
    await runner.recordReviewerDoneResult(goal.id, condition.id, failingResult());

    const scheduled = await runner.handleFailedVerification(goal.id, "Verification failed", { abort: controller.signal });

    expect(delayCalls).toEqual([10_000]);
    expect(scheduled.status).toBe("failed");
    expect(scheduled.retryCount).toBe(0);
    expect(scheduled.mainSessionId).toBe("main-session-1");
    expect(scheduled.retryState?.lastAttempt?.status).toBe("scheduled");
  });

  test("duplicate due scans do not increment retry count more than once", async () => {
    const goal = await lockedGoal(2, 1_000);
    const runner = createRunner({ sessionIds: ["main-session-1"] });
    await runToReview(goal.id, runner);
    await runner.recordReviewerDoneResult(goal.id, condition.id, failingResult());
    await runner.finalizeReviewerReview(goal.id, "NOT_DONE", {
      summary: "Retry once only",
      waitForBackoff: false,
    });
    nowMs = BASE_TIME + 1_000;

    const first = await runner.recoverDueScheduledRetries(workspaceRoot);
    const second = await runner.recoverDueScheduledRetries(workspaceRoot);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect((await manager.read(goal.id)).retryCount).toBe(1);
  });

  test("exhausted retries escalate and update retry-log through lifecycle artifacts", async () => {
    const goal = await lockedGoal(0, 5_000);
    const runner = createRunner({ sessionIds: ["main-session-1"] });
    await runToReview(goal.id, runner);
    await runner.recordReviewerDoneResult(goal.id, condition.id, failingResult());

    const escalated = await runner.finalizeReviewerReview(goal.id, "NOT_DONE", { summary: "No retry budget remains" });

    expect(escalated.status).toBe("escalated");
    expect(escalated.retryCount).toBe(0);
    expect(escalated.retryState).toMatchObject({
      retryCount: 0,
      lastFailure: { message: "Reviewer NOT_DONE: required Done Conditions need repair (tests)." },
      lastAttempt: { attempt: 1, status: "escalated" },
    });
    expect(await artifacts.readArtifact(goal.id, "retry-log.md")).toContain("retry budget exhausted");
    expect(await artifacts.readArtifact(goal.id, "final-report.md")).toContain("Final status | escalated");
  });
});
