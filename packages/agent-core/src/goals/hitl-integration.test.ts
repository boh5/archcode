import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { DoneCondition, DoneResult } from "@archcode/protocol";

import { HitlService } from "../hitl/service";
import type { HitlKind, HitlPayload, HitlResponse, HitlTrigger } from "../hitl/types";
import { setLlmAdapterForTest } from "../llm";
import { GoalArtifactManager } from "./artifacts";
import { GoalRunner } from "./runner";
import { GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-hitl-integration");

const condition: DoneCondition = {
  id: "artifact-exists",
  kind: "file_exists",
  params: { path: "artifact.txt" },
};

let workspaceRoot = "";
let manager: GoalStateManager;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  manager = new GoalStateManager(workspaceRoot);
  setLlmAdapterForTest({
    streamText: mock(),
    generateText: mock(),
  });
});

afterAll(async () => {
  setLlmAdapterForTest(undefined);
  await rm(TMP_ROOT, { recursive: true, force: true });
});

function passingResult(conditionId = condition.id): DoneResult {
  return { conditionId, passed: true, evidence: "condition passed", checkedAt: new Date().toISOString() };
}

async function lockedGoal(approvalPoints: Array<"after_plan" | "before_complete">) {
  const goal = await manager.create(
    "project-a",
    "Ship HITL integration",
    "architect",
    [condition],
    { maxRetries: 1, backoffMs: 0, escalateOnFailure: true },
    approvalPoints,
  );
  return manager.lock(goal.id, "architect");
}

function createRunner(hitlService: HitlService, options: { timeoutMs?: number } = {}): GoalRunner {
  return new GoalRunner({
    goalStateManager: manager,
    goalArtifacts: new GoalArtifactManager(workspaceRoot),
    workspaceRoot,
    hitlService: {
      request: mock((sessionId: string, kind: HitlKind, payload: HitlPayload, trigger: HitlTrigger): Promise<HitlResponse> => {
        return hitlService.request(sessionId, kind, payload, { ...trigger, timeoutMs: options.timeoutMs });
      }),
      listPending: mock((projectSlug?: string, goalId?: string, loopId?: string) => hitlService.listPending(projectSlug, goalId, loopId)),
    },
    createSession: mock(async () => `main-session-${crypto.randomUUID()}`),
    isSessionActive: mock(async () => true),
  });
}

async function readyForCompletion(runner: GoalRunner, goalId: string): Promise<void> {
  await runner.start(goalId);
  await runner.advancePhase(goalId, "build");
  await runner.advancePhase(goalId, "review");
  await runner.recordReviewerDoneResult(goalId, condition.id, passingResult());
  await runner.review(goalId);
}

async function waitForPending(hitlService: HitlService, goalId: string): Promise<string> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const pending = hitlService.listPending("project-a", goalId);
    if (pending[0]) return pending[0].hitlId;
    await sleep(5);
  }
  throw new Error("Expected pending HITL request");
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function withoutUnhandledRejections<T>(action: () => Promise<T>): Promise<T> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const result = await action();
    await flushMicrotasks();
    expect(unhandled).toEqual([]);
    return result;
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
}

describe("GoalRunner HITL integration", () => {
  test("denied after_plan approval blocks build and leaves the goal paused in plan", async () => {
    const hitlService = new HitlService();
    const runner = createRunner(hitlService);
    const goal = await lockedGoal(["after_plan"]);
    await runner.start(goal.id);

    const advancing = withoutUnhandledRejections(() => runner.advancePhase(goal.id, "build"));
    const hitlId = await waitForPending(hitlService, goal.id);
    expect(hitlService.respond(hitlId, { decision: "denied" })).toBe(true);

    const paused = await advancing;
    expect(paused.status).toBe("paused");
    expect(paused.phase).toBe("plan");
    expect(await manager.read(goal.id)).toMatchObject({ status: "paused", phase: "plan" });
    expect(hitlService.listPending("project-a", goal.id)).toEqual([]);
  });

  test("denied before_complete approval blocks completion and leaves the goal paused in review", async () => {
    const hitlService = new HitlService();
    const runner = createRunner(hitlService);
    const goal = await lockedGoal(["before_complete"]);
    await readyForCompletion(runner, goal.id);

    const completing = withoutUnhandledRejections(() => runner.complete(goal.id));
    const hitlId = await waitForPending(hitlService, goal.id);
    expect(hitlService.respond(hitlId, { decision: "denied" })).toBe(true);

    const paused = await completing;
    expect(paused.status).toBe("paused");
    expect(paused.phase).toBe("review");
    expect(await manager.read(goal.id)).toMatchObject({ status: "paused", phase: "review" });
    expect(hitlService.listPending("project-a", goal.id)).toEqual([]);
  });

  test("HITL cancel resolves pending approval and pauses the goal without leaking requests", async () => {
    const hitlService = new HitlService();
    const runner = createRunner(hitlService);
    const goal = await lockedGoal(["after_plan"]);
    await runner.start(goal.id);

    const advancing = withoutUnhandledRejections(() => runner.advancePhase(goal.id, "build"));
    const hitlId = await waitForPending(hitlService, goal.id);
    expect(hitlService.cancel(hitlId, "User cancelled approval")).toBe(true);

    const paused = await advancing;
    expect(paused.status).toBe("paused");
    expect(paused.phase).toBe("plan");
    expect(hitlService.has(hitlId)).toBe(false);
    expect(hitlService.respond(hitlId, { decision: "approved" })).toBe(false);
    expect(hitlService.listPending("project-a", goal.id)).toEqual([]);
  });

  test("HITL timeout option does not auto-cancel durable pending approval", async () => {
    const hitlService = new HitlService();
    const runner = createRunner(hitlService, { timeoutMs: 5 });
    const goal = await lockedGoal(["after_plan"]);
    await runner.start(goal.id);

    const advancing = withoutUnhandledRejections(() => runner.advancePhase(goal.id, "build"));
    const hitlId = await waitForPending(hitlService, goal.id);
    await sleep(15);

    expect(hitlService.has(hitlId)).toBe(true);
    expect(hitlService.listPending("project-a", goal.id)).toEqual([
      expect.objectContaining({ hitlId, status: "pending" }),
    ]);
    expect(hitlService.cancel(hitlId, "test cleanup")).toBe(true);

    const paused = await advancing;
    expect(paused.status).toBe("paused");
    expect(paused.phase).toBe("plan");
    expect(hitlService.has(hitlId)).toBe(false);
    expect(hitlService.respond(hitlId, { decision: "approved" })).toBe(false);
    expect(hitlService.listPending("project-a", goal.id)).toEqual([]);
    expect(await manager.read(goal.id)).toMatchObject({ status: "paused", phase: "plan" });
  });
});
