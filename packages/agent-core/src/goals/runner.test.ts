import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { GoalEvidenceRef } from "@archcode/protocol";

import { GoalRunner, GoalRunnerError, type GoalRunnerCreateSessionOptions } from "./runner";
import { GoalReviewFinalizationError, GoalReviewerAuthorizationError, GoalStateManager, GoalTransitionError } from "./state";
import { WorktreeService } from "../worktrees";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-runner");

let workspaceRoot = "";
let manager: GoalStateManager;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  manager = new GoalStateManager(workspaceRoot);
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

function createRunner(sessionIds = ["main-session-1", "retry-session-2"]): GoalRunner {
  const remaining = [...sessionIds];
  return new GoalRunner({
    goalStateManager: manager,
    createSession: mock(async () => remaining.shift() ?? `session-${crypto.randomUUID()}`),
  });
}

async function createDraft(runner: GoalRunner) {
  return runner.create({
    projectId: "project-a",
    objective: "Exercise the thin goal runner facade.",
    acceptanceCriteria: "Runner delegates to state manager and enforces reviewer finalization.",
  });
}

function evidenceRef(summary = "Targeted tests passed"): GoalEvidenceRef {
  return { kind: "test_output", ref: "runner-test", summary };
}

function reviewerAuth(goalId: string) {
  return {
    agentName: "reviewer",
    sessionRole: "review",
    sessionGoalId: goalId,
    reviewerSessionId: "review-session-1",
  };
}

describe("GoalRunner", () => {
  test("creates, patches, and starts a goal with a main session", async () => {
    const runner = createRunner();
    const draft = await createDraft(runner);
    const patched = await runner.patchDraft(draft.id, { objective: "Exercise the patched goal runner facade." });
    const running = await runner.start(patched.id);

    expect(running).toMatchObject({
      status: "running",
      title: null,
      objective: "Exercise the patched goal runner facade.",
      mainSessionId: "main-session-1",
    });
    expect(await manager.read(draft.id)).toMatchObject({ status: "running", mainSessionId: "main-session-1" });
  });

  test("start is idempotent for an already running matching session", async () => {
    const runner = createRunner(["main-session-1"]);
    const draft = await createDraft(runner);

    const first = await runner.start(draft.id, { mainSessionId: "reserved-session" });
    const second = await runner.start(draft.id, { mainSessionId: "reserved-session" });

    expect(first.status).toBe("running");
    expect(second).toEqual(first);
  });

  test("does not pass generated Goal title metadata to the main session", async () => {
    const createSession = mock(async () => "main-session-1");
    const runner = new GoalRunner({ goalStateManager: manager, createSession });
    const draft = await createDraft(runner);
    await manager.setTitleIfEmpty(draft.id, "Generated goal title");

    await runner.start(draft.id);

    expect(createSession).toHaveBeenCalledWith({
      goalId: draft.id,
      sessionRole: "main",
    });
  });

  test("pins non-isolated Goal start and retry Sessions to the canonical root", async () => {
    const createSession = mock(async (_options?: GoalRunnerCreateSessionOptions) => `session-${createSession.mock.calls.length + 1}`);
    const runner = new GoalRunner({ goalStateManager: manager, createSession, workspaceRoot });
    const draft = await createDraft(runner);

    await runner.start(draft.id);
    await runner.beginReview(draft.id);
    await runner.finalizeReview(draft.id, {
      verdict: "NOT_DONE",
      summary: "Retry in the canonical checkout.",
      authorization: reviewerAuth(draft.id),
    });
    await runner.retry(draft.id);

    expect(createSession.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ cwd: workspaceRoot }),
      expect.objectContaining({ cwd: workspaceRoot }),
    ]);
  });

  test("rejects a Loop scope that does not own the Goal and preassigned non-canonical cwd", async () => {
    const foreignCwd = join(workspaceRoot, "foreign-worktree");
    const createSession = mock(async () => "should-not-be-created");
    const runner = new GoalRunner({
      goalStateManager: manager,
      createSession,
      workspaceRoot,
      getSessionCwd: mock(async () => foreignCwd),
    });
    const explicitDraft = await createDraft(runner);

    await expect(runner.start(explicitDraft.id, {
      executionScope: { kind: "loop", loopId: "foreign-loop", cwd: foreignCwd },
    })).rejects.toBeInstanceOf(GoalRunnerError);

    const assignedDraft = await createDraft(runner);
    await manager.setMainSession(assignedDraft.id, "foreign-session");
    await expect(runner.start(assignedDraft.id)).rejects.toBeInstanceOf(GoalRunnerError);
    expect(createSession).not.toHaveBeenCalled();
  });

  test("accepts only a matching trusted Loop execution scope for a Loop-owned Goal", async () => {
    await initializeGitRepo(workspaceRoot);
    const loopId = "11111111-1111-4111-8111-111111111111";
    const createSession = mock(async () => "loop-goal-session");
    const runner = new GoalRunner({ goalStateManager: manager, createSession, workspaceRoot });
    const goal = await runner.create({
      projectId: "project-a",
      objective: "Execute inside the owning Loop scope.",
      acceptanceCriteria: "The Loop worktree is passed through an explicit trusted scope.",
      loopId,
    });

    await expect(runner.start(goal.id, {
      executionScope: { kind: "loop", loopId, cwd: "relative-loop-worktree" },
    })).rejects.toBeInstanceOf(GoalRunnerError);
    await expect(runner.start(goal.id, {
      executionScope: { kind: "loop", loopId, cwd: join(workspaceRoot, "not-registered") },
    })).rejects.toBeInstanceOf(GoalRunnerError);
    expect(createSession).not.toHaveBeenCalled();

    const loopWorktree = await new WorktreeService({ canonicalRoot: workspaceRoot }).create({
      owner: { type: "loop", id: loopId },
      uniqueId: crypto.randomUUID(),
    });

    const running = await runner.start(goal.id, {
      executionScope: { kind: "loop", loopId, cwd: loopWorktree.worktreePath },
    });

    expect(running).toMatchObject({ status: "running", loopId, mainSessionId: "loop-goal-session" });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: loopWorktree.worktreePath,
      goalId: goal.id,
      loopId,
      sessionRole: "main",
    }));
  });

  test("rejects an invalid start before preparing a Goal worktree or creating a Session", async () => {
    const createSession = mock(async () => "orphan-session");
    const createWorktree = mock(async () => {
      throw new Error("must not prepare worktree");
    });
    const findManaged = mock(async () => undefined);
    const runner = new GoalRunner({
      goalStateManager: manager,
      createSession,
      workspaceRoot,
      worktreeService: {
        create: createWorktree,
        findManaged,
        validateManagedClaim: mock(async () => {
          throw new Error("must not validate worktree");
        }),
        remove: mock(async () => false),
      } as never,
    });
    const goal = await manager.create({
      projectId: "project-a",
      objective: "Reject invalid execution before resource allocation.",
      acceptanceCriteria: "No worktree or Session is orphaned.",
      useWorktree: true,
    });
    await manager.start(goal.id, { mainSessionId: "existing-session" });
    await manager.beginReview(goal.id);

    await expect(runner.start(goal.id)).rejects.toBeInstanceOf(GoalRunnerError);
    expect(findManaged).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  test("running retry is idempotent only for the same active main Session", async () => {
    const createSession = mock(async () => "orphan-retry-session");
    const goal = await createDraft(createRunner());
    const running = await manager.start(goal.id, { mainSessionId: "running-session" });
    const inactiveRunner = new GoalRunner({
      goalStateManager: manager,
      createSession,
      workspaceRoot,
      getSessionCwd: mock(async () => workspaceRoot),
      isSessionActive: mock(async () => false),
    });

    await expect(inactiveRunner.retry(goal.id)).rejects.toBeInstanceOf(GoalRunnerError);
    await expect(inactiveRunner.retry(goal.id, { mainSessionId: "different-session" })).rejects.toBeInstanceOf(GoalRunnerError);
    expect(createSession).not.toHaveBeenCalled();

    const activeRunner = new GoalRunner({
      goalStateManager: manager,
      createSession,
      workspaceRoot,
      getSessionCwd: mock(async () => workspaceRoot),
      isSessionActive: mock(async (sessionId) => sessionId === "running-session"),
    });
    await expect(activeRunner.retry(goal.id, { mainSessionId: "running-session" })).resolves.toEqual(running);
    expect(createSession).not.toHaveBeenCalled();
  });

  test("creates one isolated Goal worktree and reuses its cwd for retry sessions", async () => {
    await initializeGitRepo(workspaceRoot);
    const createSession = mock(async (_options?: GoalRunnerCreateSessionOptions) => `session-${createSession.mock.calls.length + 1}`);
    const runner = new GoalRunner({
      goalStateManager: manager,
      createSession,
      workspaceRoot,
    });
    const draft = await runner.create({
      projectId: "project-a",
      objective: "Implement in a Goal worktree.",
      acceptanceCriteria: "Retry continues in the same isolated checkout.",
      useWorktree: true,
    });

    const running = await runner.start(draft.id);
    const firstCwd = (createSession.mock.calls[0]?.[0] as { cwd?: string } | undefined)?.cwd;
    expect(firstCwd).toBe(running.worktree?.path);
    await runner.beginReview(draft.id);
    await runner.finalizeReview(draft.id, {
      verdict: "NOT_DONE",
      summary: "More work is required.",
      authorization: reviewerAuth(draft.id),
    });

    await runner.retry(draft.id);
    expect((createSession.mock.calls[1]?.[0] as { cwd?: string } | undefined)?.cwd).toBe(firstCwd);
  });

  test("rejects a preassigned Session whose cwd does not match an isolated Goal", async () => {
    await initializeGitRepo(workspaceRoot);
    const runner = new GoalRunner({
      goalStateManager: manager,
      workspaceRoot,
      createSession: mock(async () => "unused-session"),
      getSessionCwd: mock(async () => workspaceRoot),
    });
    const draft = await runner.create({
      projectId: "project-a",
      objective: "Validate an existing Session.",
      acceptanceCriteria: "The Session must already use the Goal worktree.",
      useWorktree: true,
    });
    await manager.setMainSession(draft.id, "canonical-session");

    await expect(runner.start(draft.id)).rejects.toMatchObject({ name: "GoalRunnerError" });
    expect(await manager.read(draft.id)).toMatchObject({ status: "draft", mainSessionId: "canonical-session" });
    expect((await manager.read(draft.id)).worktree?.path).not.toBe(workspaceRoot);
  });

  test("revalidates the selected Session cwd before an idempotent isolated start", async () => {
    await initializeGitRepo(workspaceRoot);
    let sessionCwd: string | undefined;
    const createSession = mock(async (options?: GoalRunnerCreateSessionOptions) => {
      sessionCwd = options?.cwd;
      return "isolated-session";
    });
    const runner = new GoalRunner({
      goalStateManager: manager,
      workspaceRoot,
      createSession,
      getSessionCwd: mock(async () => sessionCwd),
    });
    const draft = await runner.create({
      projectId: "project-a",
      objective: "Keep idempotent claims inside the Goal worktree.",
      acceptanceCriteria: "A stale Session cwd cannot bypass isolated Goal validation.",
      useWorktree: true,
    });
    const running = await runner.start(draft.id);
    expect(sessionCwd).toBe(running.worktree?.path);

    sessionCwd = workspaceRoot;
    await expect(runner.start(draft.id, { mainSessionId: "isolated-session" }))
      .rejects.toBeInstanceOf(GoalRunnerError);
    expect((await manager.read(draft.id)).mainSessionId).toBe("isolated-session");
  });

  test("does not let an explicit cwd bypass an isolated Goal worktree claim", async () => {
    await initializeGitRepo(workspaceRoot);
    const createSession = mock(async () => "should-not-be-created");
    const runner = new GoalRunner({
      goalStateManager: manager,
      workspaceRoot,
      createSession,
    });
    const draft = await runner.create({
      projectId: "project-a",
      objective: "Reject an explicit canonical cwd for an isolated Goal.",
      acceptanceCriteria: "The Goal-owned worktree remains the only valid execution directory.",
      useWorktree: true,
    });

    await expect(runner.start(draft.id, {
      executionScope: { kind: "loop", loopId: "foreign-loop", cwd: workspaceRoot },
    })).rejects.toBeInstanceOf(GoalRunnerError);
    expect(createSession).not.toHaveBeenCalled();
    expect(await manager.read(draft.id)).toMatchObject({ status: "draft", useWorktree: true });
    expect((await manager.read(draft.id)).worktree).toBeUndefined();
  });

  test("requires createSession when no main session is available", async () => {
    const runner = new GoalRunner({ goalStateManager: manager });
    const draft = await createDraft(runner);

    await expect(runner.start(draft.id)).rejects.toBeInstanceOf(GoalRunnerError);
  });

  test("blocks and clears back to requested resume status", async () => {
    const runner = createRunner();
    const draft = await createDraft(runner);
    await runner.start(draft.id);

    const blocked = await runner.block(draft.id, {
      kind: "approval",
      summary: "Need approval",
      hitlId: "hitl-1",
      resumeStatus: "reviewing",
    });
    expect(blocked).toMatchObject({ status: "blocked", pendingHitlIds: ["hitl-1"] });

    const reviewing = await runner.clearBlocker(draft.id, "hitl-1");
    expect(reviewing).toMatchObject({ status: "reviewing", pendingHitlIds: [] });
  });

  test("finalizes DONE only from reviewer authorization with evidence", async () => {
    const runner = createRunner();
    const draft = await createDraft(runner);
    await runner.start(draft.id);
    await runner.beginReview(draft.id);

    await expect(runner.finalizeReview(draft.id, {
      verdict: "DONE",
      summary: "Missing evidence.",
      evidenceRefs: [],
      authorization: reviewerAuth(draft.id),
    })).rejects.toBeInstanceOf(GoalReviewFinalizationError);
    await expect(runner.finalizeReview(draft.id, {
      verdict: "DONE",
      summary: "Wrong agent.",
      evidenceRefs: [evidenceRef()],
      authorization: { ...reviewerAuth(draft.id), agentName: "build" },
    })).rejects.toBeInstanceOf(GoalReviewerAuthorizationError);

    const done = await runner.finalizeReview(draft.id, {
      verdict: "DONE",
      summary: "Reviewer verified all criteria.",
      evidenceRefs: [evidenceRef()],
      authorization: reviewerAuth(draft.id),
    });

    expect(done.status).toBe("done");
    expect(done.review).toMatchObject({ verdict: "DONE", reviewerSessionId: "review-session-1" });
    await expect(runner.cancel(done.id, "too late")).rejects.toBeInstanceOf(GoalTransitionError);
  });

  test("finalizes NOT_DONE, rejects duplicate finalization, then explicit retry clears review", async () => {
    const runner = createRunner();
    const draft = await createDraft(runner);
    await runner.start(draft.id);
    await runner.beginReview(draft.id);

    const notDone = await runner.finalizeReview(draft.id, {
      verdict: "NOT_DONE",
      summary: "Acceptance criteria need repair.",
      unresolvedItems: ["Add targeted tests"],
      authorization: reviewerAuth(draft.id),
    });
    expect(notDone).toMatchObject({ status: "not_done", lastFailureSummary: "Acceptance criteria need repair." });

    await expect(runner.finalizeReview(draft.id, {
      verdict: "NOT_DONE",
      summary: "duplicate",
      authorization: reviewerAuth(draft.id),
    })).rejects.toBeInstanceOf(GoalReviewFinalizationError);

    const retry = await runner.retry(draft.id);
    expect(retry).toMatchObject({ status: "running", attempt: 2, mainSessionId: "retry-session-2" });
    expect(retry.review).toBeUndefined();
    expect((await runner.beginReview(draft.id)).status).toBe("reviewing");
  });

  test("fail and cancel follow the simplified transition graph", async () => {
    const runner = createRunner();
    const failing = await createDraft(runner);
    await runner.start(failing.id);
    const failed = await runner.fail(failing.id, new Error("verification crashed"));
    expect(failed).toMatchObject({ status: "failed", lastFailureSummary: "verification crashed" });
    expect(failed.lastError).toMatchObject({ name: "Error", message: "verification crashed" });
    expect((await runner.retry(failing.id)).status).toBe("running");

    const cancelledDraft = await createDraft(runner);
    expect((await runner.cancel(cancelledDraft.id, "duplicate request")).status).toBe("cancelled");
  });

  test("tracks child sessions, main session, budget, and HITL refs", async () => {
    const runner = createRunner();
    const draft = await createDraft(runner);
    await runner.start(draft.id);
    await runner.setMainSession(draft.id, "explicit-main");
    await runner.addChildSession(draft.id, "child-1");
    await runner.recordHitlRef(draft.id, { hitlId: "hitl-1", approvalRef: "approval-1" });
    const budgeted = await runner.updateBudgetSummary(draft.id, {
      status: "ok",
      usedTokens: 10,
      maxTokens: 100,
      updatedAt: new Date().toISOString(),
    });

    expect(budgeted).toMatchObject({
      mainSessionId: "explicit-main",
      childSessionIds: ["child-1"],
      pendingHitlIds: ["hitl-1"],
      approvalRefs: ["approval-1"],
      budget: { status: "ok", usedTokens: 10, maxTokens: 100 },
    });
  });
});

async function initializeGitRepo(cwd: string): Promise<void> {
  await runGit(cwd, ["init", "--initial-branch=main"]);
  await runGit(cwd, ["config", "user.email", "goal-runner@example.com"]);
  await runGit(cwd, ["config", "user.name", "Goal Runner"]);
  await writeFile(join(cwd, "README.md"), "# Goal runner\n");
  await runGit(cwd, ["add", "README.md"]);
  await runGit(cwd, ["commit", "-m", "initial commit"]);
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(process.stderr).text();
  if (await process.exited !== 0) throw new Error(stderr);
}
