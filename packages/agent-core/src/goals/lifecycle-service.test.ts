import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { GoalEvidenceRef } from "@archcode/protocol";

import { silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import { getSessionPath } from "../store/sessions-dir";
import { managedWorktreeNames } from "../worktrees";
import { withGoalExecutionClaimLock } from "./execution-claim";
import { GoalLifecycleService, GoalLifecycleServiceError, GoalSourceSessionError, type GoalLifecycleServiceOptions } from "./lifecycle-service";
import { GoalReviewFinalizationError, GoalReviewerAuthorizationError, GoalStateManager, GoalTransitionError } from "./state";
import { testReviewExecutionFields } from "./test-review-fixture";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-lifecycle", crypto.randomUUID());
const SOURCE_SESSION_ID = "11111111-1111-4111-8111-111111111111";

let workspaceRoot = "";
let manager: GoalStateManager;
let sessions: SessionStoreManager;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  manager = new GoalStateManager(workspaceRoot);
  sessions = new SessionStoreManager({ logger: silentLogger });
  await sessions.createSessionFile(workspaceRoot, { agentName: "engineer" }, SOURCE_SESSION_ID);
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

function lifecycleOptions(overrides: Partial<GoalLifecycleServiceOptions> = {}): GoalLifecycleServiceOptions {
  return {
    goalStateManager: manager,
    workspaceRoot,
    readSourceSession: (root, id) => sessions.getSessionFile(root, id),
    ensureSessionFile: (root, id, options) => sessions.ensureSessionFile(root, id, options),
    startCheckedExecutionWithinGoalClaim: mock(async () => ({}) as never),
    ...overrides,
  };
}

function createInput() {
  return {
    projectSlug: "project-a",
    createdFromSessionId: SOURCE_SESSION_ID,
    objective: "Create and activate a committed Goal.",
    acceptanceCriteria: "One stable Goal Lead Session and initial execution are recovered.",
  };
}

function evidenceRef(summary = "Targeted tests passed"): GoalEvidenceRef {
  return { kind: "test_output", ref: "lifecycle-test", summary };
}

function reviewerAuth(goalId: string) {
  return {
    agentName: "reviewer",
    sessionRole: "review",
    sessionGoalId: goalId,
    reviewerSessionId: "review-session-1",
  };
}

describe("GoalLifecycleService committed creation", () => {
  test("commits a running Goal before creating its stable Goal Lead Session and execution", async () => {
    const observed: string[] = [];
    const onGoalCommitted = mock(async (goal) => {
      observed.push(`commit:${goal.id}`);
      expect(await sessions.getSessionFile(workspaceRoot, goal.mainSessionId).catch(() => undefined)).toBeUndefined();
    });
    const start = mock(async (input) => {
      observed.push(`start:${input.sessionId}`);
      return {} as never;
    });
    const stateManager = new GoalStateManager(workspaceRoot, undefined, onGoalCommitted);
    const lifecycle = new GoalLifecycleService(lifecycleOptions({ goalStateManager: stateManager, startCheckedExecutionWithinGoalClaim: start }));

    const goal = await lifecycle.create(createInput());
    const main = await sessions.getSessionFile(workspaceRoot, goal.mainSessionId);

    expect(goal).toMatchObject({
      status: "running",
      createdFromSessionId: SOURCE_SESSION_ID,
      startedAt: expect.any(String),
    });
    expect(main).toMatchObject({
      sessionId: goal.mainSessionId,
      rootSessionId: goal.mainSessionId,
      agentName: "goal_lead",
      sessionRole: "main",
      goalId: goal.id,
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      slug: "project-a",
      sessionId: goal.mainSessionId,
      executionId: `goal-initial:${goal.id}`,
    }));
    expect(observed).toEqual([`commit:${goal.id}`, `start:${goal.mainSessionId}`]);
    expect(onGoalCommitted).toHaveBeenCalledTimes(1);
  });

  test("runs the creation hook once and never for later state commits", async () => {
    const onCreated = mock((_goal: import("@archcode/protocol").GoalState) => {});
    const lifecycle = new GoalLifecycleService(lifecycleOptions({ onCreated }));
    const goal = await lifecycle.create(createInput());
    await lifecycle.beginReview(goal.id);

    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  test("activates the committed Goal even when the creation hook fails", async () => {
    const start = mock(async () => ({}) as never);
    const lifecycle = new GoalLifecycleService(lifecycleOptions({
      onCreated: async () => { throw new Error("title queue unavailable"); },
      startCheckedExecutionWithinGoalClaim: start,
    }));

    await expect(lifecycle.create(createInput())).rejects.toThrow("title queue unavailable");

    const [goal] = await manager.listGoals();
    expect(goal).toBeDefined();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      slug: "project-a",
      sessionId: goal!.mainSessionId,
      executionId: `goal-initial:${goal!.id}`,
    }));
    expect(await sessions.getSessionFile(workspaceRoot, goal!.mainSessionId)).toMatchObject({
      goalId: goal!.id,
      agentName: "goal_lead",
    });
  });

  test("keeps committed Goal ownership after its source Session is deleted", async () => {
    const lifecycle = new GoalLifecycleService(lifecycleOptions());
    const goal = await lifecycle.create(createInput());

    sessions.delete(SOURCE_SESSION_ID, workspaceRoot);
    await rm(dirname(getSessionPath(workspaceRoot, SOURCE_SESSION_ID)), {
      recursive: true,
      force: true,
    });

    await expect(sessions.getSessionFile(workspaceRoot, SOURCE_SESSION_ID)).rejects.toThrow();
    expect(await manager.read(goal.id)).toMatchObject({
      status: "running",
      createdFromSessionId: SOURCE_SESSION_ID,
      mainSessionId: goal.mainSessionId,
    });
    expect(await sessions.getSessionFile(workspaceRoot, goal.mainSessionId)).toMatchObject({
      goalId: goal.id,
      agentName: "goal_lead",
    });
  });

  test("rejects every non-ordinary source identity before committing", async () => {
    const invalidSources = [
      { agentName: "goal_lead" as const },
      { agentName: "engineer" as const, rootSessionId: crypto.randomUUID() },
      { agentName: "engineer" as const, parentSessionId: crypto.randomUUID() },
      { agentName: "engineer" as const, goalId: crypto.randomUUID() },
      { agentName: "engineer" as const, sessionRole: "main" as const },
    ];

    for (const [index, identity] of invalidSources.entries()) {
      const sourceId = crypto.randomUUID();
      const source = sessions.create(sourceId, workspaceRoot, identity);
      await sessions.flushSession(sourceId, workspaceRoot);
      const lifecycle = new GoalLifecycleService(lifecycleOptions({
        readSourceSession: async () => (await sessions.getSessionFile(workspaceRoot, source.getState().sessionId)),
      }));
      await expect(lifecycle.create({ ...createInput(), createdFromSessionId: sourceId }))
        .rejects.toBeInstanceOf(GoalSourceSessionError);
      expect(await manager.listGoals()).toHaveLength(index === invalidSources.length ? 1 : 0);
    }
  });

  test("recovers the commit-to-session window with the same preallocated identity", async () => {
    const firstEnsure = mock(async () => { throw new Error("temporary storage outage"); });
    const first = new GoalLifecycleService(lifecycleOptions({ ensureSessionFile: firstEnsure }));
    const committed = await first.create(createInput());
    expect(committed.status).toBe("running");
    expect(await sessions.getSessionFile(workspaceRoot, committed.mainSessionId).catch(() => undefined)).toBeUndefined();

    const start = mock(async () => ({}) as never);
    const restarted = new GoalLifecycleService(lifecycleOptions({ startCheckedExecutionWithinGoalClaim: start }));
    await restarted.reconcile();

    expect((await sessions.getSessionFile(workspaceRoot, committed.mainSessionId)).goalId).toBe(committed.id);
    expect(start).toHaveBeenCalledTimes(1);
  });

  test("recovers the worktree-to-session window without creating a second worktree", async () => {
    const createWorktree = mock(async (input) => {
      const names = managedWorktreeNames({ owner: input.owner });
      return {
        canonicalRoot: workspaceRoot,
        managedRoot: join(workspaceRoot, ".archcode-worktrees"),
        worktreePath: join(workspaceRoot, ".archcode-worktrees", names.worktreeName),
        worktreeName: names.worktreeName,
        branchName: names.branchName,
        baseSha: "a".repeat(40),
        resolvedHeadSha: "a".repeat(40),
        canonicalStatus: { dirty: false, entries: [] },
      };
    });
    const validateManagedClaim = mock(async (input) => ({
      worktree: {
        path: input.path,
        branchName: input.branchName,
        headSha: "a".repeat(40),
        isManaged: true,
      },
      baseSha: input.baseSha ?? "a".repeat(40),
    }));
    const worktreeService = {
      create: createWorktree,
      findManaged: mock(async () => undefined),
      validateManagedClaim,
      remove: mock(async () => ({ detached: true, branchDeleted: true })),
    } as never;
    const first = new GoalLifecycleService(lifecycleOptions({
      worktreeService,
      ensureSessionFile: mock(async () => { throw new Error("temporary Session persistence outage"); }),
    }));
    const goal = await first.create({ ...createInput(), useWorktree: true });
    expect(goal.worktree).toBeDefined();

    const restarted = new GoalLifecycleService(lifecycleOptions({ worktreeService }));
    await restarted.reconcile();

    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(validateManagedClaim).toHaveBeenCalledTimes(1);
    expect((await sessions.getSessionFile(workspaceRoot, goal.mainSessionId)).cwd).toBe(goal.worktree!.path);
  });

  test("recovers after Session persistence without accepting a second initial execution", async () => {
    const acceptedThenUnknown = mock(async (input) => {
      const store = await sessions.getOrLoad(input.sessionId, workspaceRoot);
      store.getState().append({ type: "execution-start", executionId: input.executionId });
      await sessions.flushSession(input.sessionId, workspaceRoot);
      throw new Error("connection dropped after execution acceptance");
    });
    const first = new GoalLifecycleService(lifecycleOptions({ startCheckedExecutionWithinGoalClaim: acceptedThenUnknown }));
    const goal = await first.create(createInput());

    const shouldNotReplay = mock(async () => ({}) as never);
    await new GoalLifecycleService(lifecycleOptions({ startCheckedExecutionWithinGoalClaim: shouldNotReplay })).reconcile();

    const session = await sessions.getSessionFile(workspaceRoot, goal.mainSessionId);
    expect(session.executions.filter((execution) => execution.id === `goal-initial:${goal.id}`)).toHaveLength(1);
    expect(shouldNotReplay).not.toHaveBeenCalled();
  });

  test("leaves busy failures recoverable but marks deterministic identity conflicts failed", async () => {
    const busy = Object.assign(new Error("SessionFamilyActiveError"), { name: "SessionFamilyActiveError" });
    const lifecycle = new GoalLifecycleService(lifecycleOptions({
      startCheckedExecutionWithinGoalClaim: mock(async () => { throw busy; }),
    }));
    expect((await lifecycle.create(createInput())).status).toBe("running");

    const conflicting = new GoalLifecycleService(lifecycleOptions({
      ensureSessionFile: async (root, id, options) => {
        const session = await sessions.ensureSessionFile(root, id, options);
        return { ...session, goalId: crypto.randomUUID() };
      },
    }));
    const failed = await conflicting.create(createInput());
    expect(failed).toMatchObject({ status: "failed", lastError: { name: "GoalLifecycleServiceError" } });
  });
});

describe("GoalLifecycleService lifecycle", () => {
  test("orchestrates review, retry, and failure lifecycle", async () => {
    const lifecycle = new GoalLifecycleService(lifecycleOptions());
    const goal = await lifecycle.create(createInput());
    expect((await lifecycle.beginReview(goal.id)).status).toBe("reviewing");
    const notDone = await lifecycle.finalizeReview(goal.id, {
      expectedReviewGeneration: 1,
      verdict: "NOT_DONE",
      ...testReviewExecutionFields("NOT_DONE"),
      summary: "More work is required.",
      authorization: reviewerAuth(goal.id),
    });
    expect(notDone.status).toBe("not_done");
    expect((await lifecycle.retry(goal.id)).status).toBe("running");
    expect((await lifecycle.fail(goal.id, "build failed")).status).toBe("failed");
    expect((await lifecycle.retry(goal.id)).status).toBe("running");
  });

  test("finalizes DONE only with reviewer authorization and evidence", async () => {
    const lifecycle = new GoalLifecycleService(lifecycleOptions());
    const goal = await lifecycle.create(createInput());
    await lifecycle.beginReview(goal.id);

    await expect(lifecycle.finalizeReview(goal.id, {
      expectedReviewGeneration: 1,
      verdict: "DONE",
      ...testReviewExecutionFields("DONE"),
      summary: "Missing evidence.",
      evidenceRefs: [],
      authorization: reviewerAuth(goal.id),
    })).rejects.toBeInstanceOf(GoalReviewFinalizationError);
    await expect(lifecycle.finalizeReview(goal.id, {
      expectedReviewGeneration: 1,
      verdict: "DONE",
      ...testReviewExecutionFields("DONE"),
      summary: "Wrong reviewer.",
      evidenceRefs: [evidenceRef()],
      authorization: { ...reviewerAuth(goal.id), agentName: "build" },
    })).rejects.toBeInstanceOf(GoalReviewerAuthorizationError);

    const done = await lifecycle.finalizeReview(goal.id, {
      expectedReviewGeneration: 1,
      verdict: "DONE",
      ...testReviewExecutionFields("DONE"),
      summary: "All criteria verified.",
      evidenceRefs: [evidenceRef()],
      authorization: reviewerAuth(goal.id),
    });
    expect(done.status).toBe("done");
    await expect(lifecycle.retry(goal.id)).rejects.toBeInstanceOf(GoalTransitionError);
  });

  test("validates prepared workspace and stable main Session identity before retry commit", async () => {
    const lifecycle = new GoalLifecycleService(lifecycleOptions());
    const goal = await lifecycle.create(createInput());
    await lifecycle.beginReview(goal.id);
    await lifecycle.finalizeReview(goal.id, {
      expectedReviewGeneration: 1,
      verdict: "NOT_DONE",
      ...testReviewExecutionFields("NOT_DONE"),
      summary: "Retry after correcting the implementation.",
      authorization: reviewerAuth(goal.id),
    });
    const conflicting = new GoalLifecycleService(lifecycleOptions({
      ensureSessionFile: async (root, id, options) => ({
        ...await sessions.ensureSessionFile(root, id, options),
        goalId: crypto.randomUUID(),
      }),
    }));

    await expect(conflicting.retry(goal.id)).rejects.toBeInstanceOf(GoalLifecycleServiceError);
    expect((await manager.read(goal.id)).status).toBe("not_done");
  });

  test("holds the Goal execution claim across readiness check and review commit", async () => {
    const order: string[] = [];
    const committed = mock((state: import("@archcode/protocol").GoalState) => {
      if (state.status === "reviewing") order.push("review-committed");
    });
    const stateManager = new GoalStateManager(workspaceRoot, undefined, committed);
    const lifecycle = new GoalLifecycleService(lifecycleOptions({ goalStateManager: stateManager }));
    const goal = await lifecycle.create(createInput());
    let releaseGuard!: () => void;
    const guardBlocked = new Promise<void>((resolveGuard) => { releaseGuard = resolveGuard; });
    let guardEntered!: () => void;
    const entered = new Promise<void>((resolveEntered) => { guardEntered = resolveEntered; });

    const beginReview = lifecycle.beginReview(goal.id, async () => {
      order.push("guard-entered");
      guardEntered();
      await guardBlocked;
    });
    await entered;
    const competitor = withGoalExecutionClaimLock(goal.id, async () => {
      order.push("competitor-entered");
    });
    await Bun.sleep(5);
    expect(order).toEqual(["guard-entered"]);

    releaseGuard();
    await Promise.all([beginReview, competitor]);
    expect(order).toEqual(["guard-entered", "review-committed", "competitor-entered"]);
  });
});
