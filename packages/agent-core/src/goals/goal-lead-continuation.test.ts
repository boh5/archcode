import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { SessionFile } from "../store/helpers";
import { silentLogger } from "../logger";
import { createTestProjectContext } from "../tools/test-project-context";
import {
  GoalLeadContinuationService,
  buildGoalContinuationPrompt,
} from "./goal-lead-continuation";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-lead-continuation");

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("GoalLeadContinuationService", () => {
  test("starts only the bound direct Goal Lead root with a fresh Goal snapshot", async () => {
    const fixture = await createFixture("running");
    const outcome = await fixture.service.kick(fixture.workspaceRoot, fixture.goal.id);

    expect(outcome).toBe("started");
    expect(fixture.starts).toHaveLength(1);
    expect(fixture.starts[0]).toMatchObject({
      sessionId: fixture.mainSessionId,
      workspaceRoot: fixture.workspaceRoot,
    });
    expect(fixture.starts[0]?.userMessage).toContain(fixture.goal.objective);
    expect(fixture.starts[0]?.userMessage).toContain(fixture.goal.acceptanceCriteria);
    expect(fixture.starts[0]?.userMessage).toContain(`"reviewGeneration": ${fixture.goal.reviewGeneration}`);
  });

  test("stops for pending HITL, blocked budget, terminal status, and wrong root identity", async () => {
    const pending = await createFixture("stop-pending");
    await pending.context.goalState.attachHitlBlocker(pending.goal.id, {
      blocker: { kind: "question", summary: "answer", hitlId: "hitl-1" },
      approvalRef: "hitl-1",
    });
    const budget = await createFixture("stop-budget");
    await budget.context.goalState.updateBudgetSummary(budget.goal.id, {
      status: "blocked",
      updatedAt: new Date().toISOString(),
    });
    const terminal = await createFixture("stop-terminal");
    await terminal.context.goalState.cancel(terminal.goal.id, "stop");
    for (const fixture of [pending, budget, terminal]) {
      expect(await fixture.service.kick(fixture.workspaceRoot, fixture.goal.id)).toBe("ineligible");
      expect(fixture.starts).toHaveLength(0);
    }

    const wrong = await createFixture("wrong-root", { rootSessionId: "another-root" });
    expect(await wrong.service.kick(wrong.workspaceRoot, wrong.goal.id)).toBe("ineligible");
  });

  test("does not continue a direct Goal while any child Session has durable HITL", async () => {
    const fixture = await createFixture("child-hitl", { familyBlockedHitlIds: ["child-hitl-1"] });

    expect(await fixture.service.kick(fixture.workspaceRoot, fixture.goal.id)).toBe("ineligible");
    expect(fixture.starts).toHaveLength(0);

    const raced = await createFixture("child-hitl-race", { startErrorOnce: namedError("SessionHitlBlockedError") });
    expect(await raced.service.kick(raced.workspaceRoot, raced.goal.id)).toBe("ineligible");
    expect(raced.starts).toHaveLength(0);
  });

  test("deduplicates racing idle, startup, and explicit kicks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await createFixture("race", { startGate: gate });

    const first = fixture.service.kick(fixture.workspaceRoot, fixture.goal.id);
    await waitFor(() => fixture.starts.length === 1);
    const second = await fixture.service.kick(fixture.workspaceRoot, fixture.goal.id);
    expect(second).toBe("deduplicated");
    release();
    expect(await first).toBe("started");
    expect(fixture.starts).toHaveLength(1);
  });

  test("reconciles eligible Goals at startup and evaluates the bound Goal on family idle", async () => {
    const startup = await createFixture("startup");
    await startup.service.reconcileWorkspace(startup.workspaceRoot);
    expect(startup.starts).toHaveLength(1);

    const idle = await createFixture("idle");
    await idle.service.onFamilyIdle(idle.workspaceRoot, idle.mainSessionId);
    expect(idle.starts).toHaveLength(1);
    await idle.service.onFamilyIdle(idle.workspaceRoot, "unrelated-root");
    expect(idle.starts).toHaveLength(2);
  });

  test("retries a transient per-Goal reconciliation failure without another external trigger", async () => {
    const fixture = await createFixture("transient-reconcile", {
      getSessionErrorOnce: new Error("transient Session read failure"),
      retryBaseDelayMs: 5,
    });

    await fixture.service.reconcileWorkspace(fixture.workspaceRoot);
    expect(fixture.starts).toHaveLength(0);
    await waitFor(() => fixture.starts.length === 1);
  });

  test("backs off failed turns, rescans after capacity frees, and stops before shutdown aborts", async () => {
    const failed = await createFixture("failed", { executionStatus: "failed", retryBaseDelayMs: 5 });
    await failed.service.onFamilyIdle(failed.workspaceRoot, failed.mainSessionId);
    expect(failed.starts).toHaveLength(0);
    await waitFor(() => failed.starts.length === 1);

    const capacity = await createFixture("capacity", { startErrorOnce: namedError("ConcurrentSessionLimitError") });
    expect(await capacity.service.kick(capacity.workspaceRoot, capacity.goal.id)).toBe("capacity");
    await capacity.service.onFamilyIdle(capacity.workspaceRoot, "some-other-family");
    expect(capacity.starts).toHaveLength(1);

    const shutdown = await createFixture("shutdown");
    shutdown.service.shutdown();
    expect(await shutdown.service.kick(shutdown.workspaceRoot, shutdown.goal.id)).toBe("shutdown");
    await shutdown.service.onFamilyIdle(shutdown.workspaceRoot, shutdown.mainSessionId);
    expect(shutdown.starts).toHaveLength(0);

    const removed = await createFixture("removed-workspace", { executionStatus: "failed", retryBaseDelayMs: 20 });
    await removed.service.onFamilyIdle(removed.workspaceRoot, removed.mainSessionId);
    removed.service.releaseWorkspace(removed.workspaceRoot);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(removed.starts).toHaveLength(0);
  });

  test("serves capacity waiters FIFO instead of restarting the just-idled Goal forever", async () => {
    let slotBusy = false;
    const fixture = await createFixture("capacity-fairness", {
      onStart: () => {
        if (slotBusy) throw namedError("ConcurrentSessionLimitError");
        slotBusy = true;
      },
    });
    const secondMainSessionId = crypto.randomUUID();
    const secondGoal = await fixture.context.goalState.commit({
      id: crypto.randomUUID(),
      projectId: fixture.context.project.slug,
      createdFromSessionId: crypto.randomUUID(),
      objective: "Run the second Goal fairly",
      acceptanceCriteria: "The capacity waiter starts next",
      mainSessionId: secondMainSessionId,
    });
    fixture.sessions.set(secondMainSessionId, {
      ...fixture.sessions.get(fixture.mainSessionId)!,
      sessionId: secondMainSessionId,
      rootSessionId: secondMainSessionId,
      goalId: secondGoal.id,
    });

    await fixture.service.reconcileWorkspace(fixture.workspaceRoot);
    expect(fixture.starts).toHaveLength(1);
    const firstSessionId = fixture.starts[0]!.sessionId;
    slotBusy = false;
    await fixture.service.onFamilyIdle(fixture.workspaceRoot, firstSessionId);

    expect(fixture.starts).toHaveLength(2);
    expect(fixture.starts[1]!.sessionId).not.toBe(firstSessionId);
  });

  test("not_done prompt requires retry before Plan or Build delegation", async () => {
    const fixture = await createFixture("prompt");
    const prompt = buildGoalContinuationPrompt({
      ...fixture.goal,
      status: "not_done",
      lastFailureSummary: "Tests still fail",
    });
    expect(prompt).toContain("goal_manage.retry before any Plan or Build delegation");
    expect(prompt).toContain("Tests still fail");
  });
});

async function createFixture(
  name: string,
  options: {
    readonly rootSessionId?: string;
    readonly startGate?: Promise<void>;
    readonly executionStatus?: "failed" | "timed_out";
    readonly retryBaseDelayMs?: number;
    readonly startErrorOnce?: Error;
    readonly getSessionErrorOnce?: Error;
    readonly familyBlockedHitlIds?: readonly string[];
    readonly onStart?: (sessionId: string) => void | Promise<void>;
  } = {},
) {
  const workspaceRoot = join(TMP_ROOT, name);
  await mkdir(workspaceRoot, { recursive: true });
  const context = createTestProjectContext(workspaceRoot);
  const mainSessionId = crypto.randomUUID();
  const goal = await context.goalState.commit({
    id: crypto.randomUUID(),
    projectId: context.project.slug,
    createdFromSessionId: crypto.randomUUID(),
    objective: "Ship continuation safely",
    acceptanceCriteria: "One checked continuation starts",
    mainSessionId,
  });
  const starts: Array<{ sessionId: string; workspaceRoot: string; userMessage: string }> = [];
  const session = {
    schemaVersion: 1,
    sessionId: mainSessionId,
    rootSessionId: options.rootSessionId ?? mainSessionId,
    cwd: workspaceRoot,
    agentName: "goal_lead",
    goalId: goal.id,
    sessionRole: "main",
    executions: options.executionStatus === undefined ? [] : [{ id: "execution-1", status: options.executionStatus }],
  } as unknown as SessionFile;
  const sessions = new Map<string, SessionFile>([[mainSessionId, session]]);
  let startError = options.startErrorOnce;
  let getSessionError = options.getSessionErrorOnce;
  const service = new GoalLeadContinuationService({
    projectContextResolver: { resolve: async () => context },
    sessionRuntime: {
      getSessionFile: async (_workspaceRoot, sessionId) => {
        if (getSessionError !== undefined) {
          const error = getSessionError;
          getSessionError = undefined;
          throw error;
        }
        const found = sessions.get(sessionId);
        if (found === undefined) throw new Error(`Missing Session ${sessionId}`);
        return found;
      },
      getSessionFamilyActivity: () => "idle",
      listSessionFamilyBlockedHitlIds: async () => [...(options.familyBlockedHitlIds ?? [])],
      startCheckedExecutionWithinGoalClaim: mock(async (input) => {
        if (startError !== undefined) {
          const error = startError;
          startError = undefined;
          throw error;
        }
        await options.onStart?.(input.sessionId);
        starts.push({ sessionId: input.sessionId, workspaceRoot: input.workspaceRoot, userMessage: input.userMessage });
        await options.startGate;
        return { promise: Promise.resolve() } as never;
      }),
    },
    logger: silentLogger,
    retryBaseDelayMs: options.retryBaseDelayMs,
  });
  return { workspaceRoot, context, mainSessionId, goal, sessions, starts, service };
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out");
}
