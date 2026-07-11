import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { HitlRecord } from "@archcode/protocol";
import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { ResumeCoordinator } from "../hitl/resume-coordinator";
import { LoopStateManager } from "../loops/state";
import { CollisionLedger } from "../loops/collision-ledger";
import { LoopJobCoordinator } from "../loops/coordinator";
import { LoopJobQueue } from "../loops/job-queue";
import { LoopSessionHitlContinuationCoordinator } from "../loops/session-hitl-continuation";
import { setLlmAdapterForTest } from "../llm";
import type { Agent, AgentRunOptions } from "../agents/types";
import type { SessionAgentManager } from "../agents/session-agent-manager";
import { SessionHitlBlockedError } from "../agents/errors";
import { MemoryFileManager } from "../memory/file-manager";
import { ProjectContextResolver } from "../projects/context-resolver";
import type { ProjectContext } from "../projects/types";
import type { ModelInfo } from "../provider/model";
import { SessionStoreManager } from "../store/session-store-manager";
import { getSessionHitlPath, getSessionPath } from "../store/sessions-dir";
import { createRegistry, defineTool } from "../tools";
import { askUserTool } from "../tools/builtins";
import { ProjectApprovalManager } from "../tools/permission";
import { createTestProjectContext } from "../tools/test-project-context";
import { SkillService } from "../skills";
import { silentLogger } from "../logger";
import { runQueryLoop } from "../agents/query/loop";
import type { QueryLoopOptions } from "../agents/query/types";
import { SessionHitlResumeAdapter, type SessionLoopHitlContinuationCoordinator } from "./session-hitl-resume-adapter";
import { SessionExecutionManager, type SessionHitlResumeLease } from "./session-execution-manager";
import { SessionExecutionScopeConflictError, SessionExecutionScopeValidator } from "./session-execution-scope-validator";
import {
  getSessionHitlCheckpointPath,
  readSessionHitlCheckpoint,
  readSessionHitlCheckpointFile,
  sessionHitlJournalPhase,
  transitionSessionHitlJournalPhase,
  writeSessionHitlCheckpoint,
} from "./session-hitl-checkpoint";
import { WorktreeService } from "../worktrees";

type StreamTextFn = typeof import("ai").streamText;

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "session-hitl-resume");

function identity(record: Pick<HitlRecord, "owner" | "hitlId">) {
  return { owner: record.owner, hitlId: record.hitlId };
}
const testSkillService = new SkillService({ builtinSkills: {} });
const allowLoopExecutionClaims = { resolve: async () => ({ outcome: "allow" as const }) };
const dummyModelInfo = {
  model: { modelId: "mock-model", provider: "mock-provider" },
  displayName: "Mock Model",
  limit: { context: 1000, output: 100 },
  modalities: { input: ["text"], output: ["text"] },
  providerId: "mock-provider",
  modelId: "mock-model",
  qualifiedId: "mock-provider:mock-model",
} as unknown as ModelInfo;

describe("Session HITL resume", () => {
  beforeEach(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
    await mkdir(TMP_ROOT, { recursive: true });
  });

  afterAll(async () => {
    setLlmAdapterForTest(undefined);
    await rm(TMP_ROOT, { recursive: true, force: true });
  });

  test("ask_user creates durable Session HITL and resumes exact tool result", async () => {
    const fixture = await createFixture();
    const registry = createRegistry([askUserTool]);
    mockToolCallStream([{ toolCallId: "ask-1", toolName: "ask_user", input: {
      questions: [{ header: "Pick", question: "Choose a color", options: [], custom: true }],
    } }]);

    await runQueryLoop(fixture.options(registry, ["ask_user"]), "ask");

    const pending = await singlePendingHitl(fixture);
    expect(pending.source).toEqual({ type: "ask_user", sessionId: fixture.sessionId, toolCallId: "ask-1" });
    expect(fixture.store.getState().executions.at(-1)).toMatchObject({ status: "waiting_for_human" });
    expect(fixture.store.getState().blockedByHitlIds).toEqual([pending.hitlId]);
    expect(JSON.stringify(await Bun.file(getSessionHitlPath(fixture.workspaceRoot, fixture.sessionId)).json())).not.toContain("rawToolInput");
    const checkpointFile = await readSessionHitlCheckpointFile(fixture.workspaceRoot, fixture.sessionId);
    expect(JSON.stringify(checkpointFile)).toContain("Choose a color");

    await fixture.coordinator.respond(identity(pending), { type: "question_answer", answers: ["blue"] });
    await waitFor(async () => (await fixture.hitl.lookup(identity(pending))).status === "found" && ((await fixture.hitl.lookup(identity(pending))) as { record: HitlRecord }).record.status === "resolved");

    const tool = latestToolPart(fixture.store.getState().messages, "ask-1");
    expect(tool).toMatchObject({ state: "completed", output: "blue" });
    const coldSessions = new SessionStoreManager({ logger: silentLogger });
    const coldStore = await coldSessions.getOrLoad(fixture.sessionId, fixture.workspaceRoot);
    expect(coldStore.getState().blockedHitl).toBeUndefined();
    expect(coldStore.getState().blockedByHitlIds).toBeUndefined();
    expect(await readSessionHitlCheckpoint(fixture.workspaceRoot, fixture.sessionId, pending.hitlId)).toBeUndefined();
  });

  test("journal persistence failure publishes no owner record", async () => {
    const fixture = await createFixture();
    const execute = mock(async () => "must not execute");
    const registry = createRegistry([guardedTool("checkpoint_failure_guarded", execute)]);
    await mkdir(getSessionHitlCheckpointPath(fixture.workspaceRoot, fixture.sessionId), { recursive: true });
    mockToolCallStream([{ toolCallId: "checkpoint-failure-1", toolName: "checkpoint_failure_guarded", input: {} }]);

    await runQueryLoop({ ...fixture.options(registry, ["checkpoint_failure_guarded"]), maxSteps: 1 }, "force checkpoint failure");

    const owner = { projectSlug: "archcode", ownerType: "session" as const, ownerId: fixture.sessionId };
    const file = await (await fixture.hitl.ownerStore(owner)).read();
    expect(file.pending).toEqual([]);
    expect(file.recentTerminal).toEqual([]);
    expect(fixture.store.getState().executions.at(-1)?.status).not.toBe("waiting_for_human");
    expect(execute).not.toHaveBeenCalled();
  });

  test("checkpoint persistence failure does not cancel a reused blocking-key record", async () => {
    const fixture = await createFixture();
    const toolCallId = "checkpoint-existing-1";
    const owner = { projectSlug: "archcode", ownerType: "session" as const, ownerId: fixture.sessionId };
    const existing = await fixture.hitl.create({
      owner,
      blockingKey: `session:${fixture.sessionId}:tool:${toolCallId}`,
      source: { type: "tool_permission", sessionId: fixture.sessionId, toolCallId, toolName: "checkpoint_existing_guarded" },
      displayPayload: { title: "Existing approval", redacted: true },
    });
    await mkdir(getSessionHitlCheckpointPath(fixture.workspaceRoot, fixture.sessionId), { recursive: true });
    const registry = createRegistry([guardedTool("checkpoint_existing_guarded", mock(async () => "must not execute"))]);
    mockToolCallStream([{ toolCallId, toolName: "checkpoint_existing_guarded", input: {} }]);

    await runQueryLoop({ ...fixture.options(registry, ["checkpoint_existing_guarded"]), maxSteps: 1 }, "reuse pending owner record");

    const file = await (await fixture.hitl.ownerStore(owner)).read();
    expect(file.pending).toHaveLength(1);
    expect(file.pending[0]).toMatchObject({ hitlId: existing.hitlId, status: "pending" });
    expect(file.recentTerminal).toEqual([]);
  });

  test("realtime publish failure still leaves a durable checkpoint and enters Session HITL pause", async () => {
    const fixture = await createFixture();
    fixture.hitl.subscribeRealtimeEvents(() => { throw new Error("SSE unavailable"); });
    const registry = createRegistry([askUserTool]);
    mockToolCallStream([{ toolCallId: "ask-publish-failure", toolName: "ask_user", input: {
      questions: [{ header: "Continue", question: "Continue despite SSE failure?", options: [], custom: true }],
    } }]);

    await runQueryLoop(fixture.options(registry, ["ask_user"]), "ask with failing publisher");

    const pending = await singlePendingHitl(fixture);
    expect(await readSessionHitlCheckpoint(fixture.workspaceRoot, fixture.sessionId, pending.hitlId)).toBeDefined();
    expect(fixture.store.getState().executions.at(-1)).toMatchObject({ status: "waiting_for_human" });
    expect(fixture.store.getState().blockedByHitlIds).toEqual([pending.hitlId]);
  });

  test("Loop-owned Session HITL reacquires the exact job and collision lease before tool replay, then finishes the run", async () => {
    let continuation!: LoopSessionHitlContinuationCoordinator;
    const fixture = await createFixture({
      loopContinuation: { acquire: async (input) => await continuation.acquire(input) },
    });
    const loop = await fixture.loopState.create("archcode", {
      templateId: "watch_report",
      title: null,
      schedule: { kind: "manual" },
      approvalPolicy: "interactive",
      limits: { maxIterationsPerRun: 3, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
      collisionTargets: [{ type: "file", path: "." }],
      useWorktree: false,
    });
    fixture.store.setState({ loopId: loop.loopId });
    const jobQueue = new LoopJobQueue({ workspaceRoot: fixture.workspaceRoot, clock: { now: () => 1_000 } });
    const jobCoordinator = new LoopJobCoordinator({
      queue: jobQueue,
      clock: { now: () => 1_000 },
      incarnationId: "session-hitl-test",
    });
    const collisionLedger = new CollisionLedger({
      stateManager: fixture.loopState,
      workspaceRoot: fixture.workspaceRoot,
      clock: { now: () => 1_000 },
    });
    const enqueued = await jobQueue.enqueue({
      loopId: loop.loopId,
      triggerKind: "manual",
      subjectKey: `manual:${loop.loopId}`,
    });
    const claimed = (await jobCoordinator.dispatchReady())[0]!;
    const runId = crypto.randomUUID();
    const runningReport = {
      runId,
      loopId: loop.loopId,
      status: "running" as const,
      trigger: "manual" as const,
      startedAt: 1_000,
      jobId: claimed.jobId,
      subjectKey: claimed.subjectKey,
      sessionId: fixture.sessionId,
      collisionTargets: loop.config.collisionTargets,
    };
    await fixture.loopState.recordRunStart(loop.loopId, runningReport);
    expect((await collisionLedger.acquireStaticTargets({ loop, runId, priority: claimed.priority })).every((result) => result.acquired)).toBe(true);

    let protectedDuringReplay = false;
    let unrelatedStayedPending = false;
    let unrelatedJobId = "";
    const execute = mock(async () => {
      const currentJob = await jobQueue.read(claimed.jobId);
      const unrelatedJob = await jobQueue.read(unrelatedJobId);
      const leases = await collisionLedger.readActiveLeases();
      protectedDuringReplay = currentJob.status === "running"
        && currentJob.leaseToken !== undefined
        && leases.some((lease) => lease.loopId === loop.loopId && lease.runId === runId);
      unrelatedStayedPending = unrelatedJob.status === "pending";
      return "continued under Loop lease";
    });
    const registry = createRegistry([guardedTool("loop_resume_guarded", execute)]);
    const origin = {
      kind: "loop" as const,
      loopId: loop.loopId,
      runId,
      trigger: "manual" as const,
      approvalPolicy: "interactive" as const,
    };
    mockToolCallStream([{ toolCallId: "loop-resume-guarded-1", toolName: "loop_resume_guarded", input: {} }]);
    await runQueryLoop({ ...fixture.options(registry, ["loop_resume_guarded"]), origin }, "pause Loop Session");
    const pending = await singlePendingHitl(fixture);
    const blockedReport = {
      ...runningReport,
      status: "needs_user" as const,
      endedAt: 1_000,
      blockedReason: "needs_user",
      blockedByHitlIds: [pending.hitlId],
      attentionStatus: "waiting_for_human" as const,
      resumeCheckpoint: {
        version: 1 as const,
        hitlId: pending.hitlId,
        loopId: loop.loopId,
        runId,
        jobId: claimed.jobId,
        trigger: "manual" as const,
        subjectKey: claimed.subjectKey,
        intendedContinuation: "resume_run" as const,
      },
      summary: "Session is waiting for user input.",
    };
    await fixture.loopState.recordRunBlocked(loop.loopId, blockedReport);
    await jobCoordinator.finish(claimed.jobId, {
      leaseOwnerId: claimed.leaseOwnerId!,
      leaseToken: claimed.leaseToken!,
    }, {
      status: "needs_user",
      blockedReason: "needs_user",
      blockedByHitlIds: [pending.hitlId],
      attentionStatus: "waiting_for_human",
      resumeCheckpoint: blockedReport.resumeCheckpoint,
    });
    await collisionLedger.releaseRun(loop.loopId, runId);
    unrelatedJobId = (await jobQueue.enqueue({
      loopId: loop.loopId,
      triggerKind: "manual",
      subjectKey: `unrelated:${loop.loopId}`,
      priority: 100,
    })).job.jobId;
    continuation = new LoopSessionHitlContinuationCoordinator({
      stateManager: fixture.loopState,
      jobQueue,
      jobCoordinator,
      collisionLedger,
      now: () => 1_000,
      scheduleCleanup: () => undefined,
    });

    await fixture.coordinator.respond(identity(pending), { type: "permission_decision", decision: "approve_once" });
    await waitFor(async () => {
      const found = await fixture.hitl.lookup(identity(pending));
      return found.status === "found" && found.record.status === "resolved";
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(protectedDuringReplay).toBe(true);
    expect(unrelatedStayedPending).toBe(true);
    expect((await jobQueue.read(unrelatedJobId)).status).toBe("pending");
    expect(await jobQueue.read(enqueued.job.jobId)).toMatchObject({ status: "succeeded", attentionStatus: "clear" });
    const finished = await fixture.loopState.read(loop.loopId);
    expect(finished.currentRun).toBeUndefined();
    expect(finished.lastRun?.status).toBe("succeeded");
    expect(finished.attentionStatus).toBe("clear");
    expect(await collisionLedger.readActiveLeases()).toEqual([]);
  });

  test("stores HITL checkpoints under the project root and resumes tools in Session cwd", async () => {
    const fixture = await createFixture();
    await initializeGitRepo(fixture.workspaceRoot);
    const worktreeCwd = (await new WorktreeService({ canonicalRoot: fixture.workspaceRoot }).create({
      owner: { type: "session", id: fixture.sessionId },
    })).worktreePath;
    await fixture.sessions.updateCwd(fixture.sessionId, fixture.workspaceRoot, worktreeCwd, fixture.workspaceRoot);
    let resumedCwd: string | undefined;
    const tool = defineTool({
      name: "cwd_guarded",
      description: "Capture resumed cwd",
      inputSchema: z.object({}).strict(),
      traits: { readOnly: false, destructive: true, concurrencySafe: false },
      permissions: [async () => ({ outcome: "ask", reason: "Approve cwd capture" })],
      execute: async (_input, ctx) => {
        resumedCwd = ctx.cwd;
        return "cwd captured";
      },
    });
    const registry = createRegistry([tool]);
    mockToolCallStream([{ toolCallId: "cwd-guarded-1", toolName: "cwd_guarded", input: {} }]);

    await runQueryLoop(
      { ...fixture.options(registry, ["cwd_guarded"]), cwd: worktreeCwd },
      "capture cwd",
    );
    const pending = await singlePendingHitl(fixture);

    expect(await Bun.file(join(worktreeCwd, ".archcode", "sessions", fixture.sessionId, "hitl-checkpoints.json")).exists()).toBe(false);
    expect((await readSessionHitlCheckpointFile(fixture.workspaceRoot, fixture.sessionId)).checkpoints).toHaveLength(1);

    await fixture.coordinator.respond(identity(pending), { type: "permission_decision", decision: "approve_once" });
    await waitFor(() => resumedCwd !== undefined);

    expect(resumedCwd).toBe(worktreeCwd);
  });

  test("fails closed before resuming a tool when persisted Session cwd is not a registered worktree", async () => {
    const fixture = await createFixture();
    const execute = mock(async () => "must not execute");
    const tool = guardedTool("invalid_cwd_guarded", execute);
    const registry = createRegistry([tool]);
    mockToolCallStream([{ toolCallId: "invalid-cwd-1", toolName: "invalid_cwd_guarded", input: {} }]);

    await runQueryLoop(fixture.options(registry, ["invalid_cwd_guarded"]), "pause before cwd tampering");
    const pending = await singlePendingHitl(fixture);
    const outside = join(fixture.workspaceRoot, "..", "not-a-worktree");
    await mkdir(outside, { recursive: true });
    await fixture.sessions.updateCwd(fixture.sessionId, fixture.workspaceRoot, outside, fixture.workspaceRoot);

    await fixture.coordinator.respond(identity(pending), { type: "permission_decision", decision: "approve_once" });
    await waitFor(async () => {
      const found = await fixture.hitl.lookup(identity(pending));
      return found.status === "found" && found.record.status === "resume_failed";
    });

    expect(execute).not.toHaveBeenCalled();
  });

  test("approved cwd transition skips later calls from the pre-transition assistant response", async () => {
    const fixture = await createFixture();
    const nextCwd = join(fixture.workspaceRoot, "..", "approved-worktree-cwd");
    await mkdir(nextCwd, { recursive: true });
    const staleExecute = mock(async () => "must not run");
    const transition = defineTool({
      name: "approved_cwd_transition",
      description: "Change cwd after approval",
      inputSchema: z.object({}).strict(),
      traits: { readOnly: false, destructive: false, concurrencySafe: false },
      permissions: [async () => ({ outcome: "ask", reason: "Approve cwd transition" })],
      execute: async (_input, ctx) => {
        ctx.store.getState().setCwd(nextCwd);
        return { output: "cwd changed", isError: false, meta: { sessionCwdChanged: true } };
      },
    });
    const stale = defineTool({
      name: "stale_after_transition",
      description: "Must be skipped",
      inputSchema: z.object({}).strict(),
      traits: { readOnly: false, destructive: true, concurrencySafe: false },
      permissions: [async () => ({ outcome: "allow" })],
      execute: staleExecute,
    });
    const registry = createRegistry([transition, stale]);
    mockToolCallStream([
      { toolCallId: "approved-transition-1", toolName: "approved_cwd_transition", input: {} },
      { toolCallId: "stale-after-transition-1", toolName: "stale_after_transition", input: {} },
    ]);

    await runQueryLoop(fixture.options(registry, ["approved_cwd_transition", "stale_after_transition"]), "switch cwd");
    const pending = await singlePendingHitl(fixture);
    await fixture.coordinator.respond(identity(pending), { type: "permission_decision", decision: "approve_once" });
    await waitFor(() => fixture.store.getState().cwd === nextCwd);

    expect(staleExecute).not.toHaveBeenCalled();
    const stalePart = latestToolPart(fixture.store.getState().messages, "stale-after-transition-1");
    expect(stalePart).toMatchObject({ state: "error" });
    expect(JSON.stringify(stalePart)).toContain("SESSION_CWD_CHANGED");
  });

  test("resume attaches the session event bridge until continuation completes", async () => {
    const attachSessionEvents = mock(() => undefined);
    const detachSessionEvents = mock(() => undefined);
    const fixture = await createFixture({ attachSessionEvents, detachSessionEvents });
    const registry = createRegistry([askUserTool]);
    mockToolCallStream([{ toolCallId: "ask-bridge", toolName: "ask_user", input: {
      questions: [{ header: "Bridge", question: "Continue?", options: [], custom: true }],
    } }]);

    await runQueryLoop(fixture.options(registry, ["ask_user"]), "ask");
    const pending = await singlePendingHitl(fixture);

    await fixture.coordinator.respond(identity(pending), { type: "question_answer", answers: ["yes"] });
    await waitFor(async () => (await fixture.hitl.lookup(identity(pending))).status === "found" && ((await fixture.hitl.lookup(identity(pending))) as { record: HitlRecord }).record.status === "resolved");

    expect(attachSessionEvents).toHaveBeenCalledTimes(1);
    expect(attachSessionEvents).toHaveBeenCalledWith(fixture.workspaceRoot, fixture.sessionId, fixture.store);
    expect(detachSessionEvents).toHaveBeenCalledTimes(1);
    expect(detachSessionEvents).toHaveBeenCalledWith(fixture.workspaceRoot, fixture.sessionId);
  });

  test("resume detaches the session event bridge when continuation fails", async () => {
    const attachSessionEvents = mock(() => undefined);
    const detachSessionEvents = mock(() => undefined);
    const fixture = await createFixture({
      attachSessionEvents,
      detachSessionEvents,
      getAgent: ({ store }) => ({
        store,
        cwd: store.getState().cwd,
        run: mock(async () => {
          throw new Error("resume failed after attach");
        }),
        dispose: mock(() => undefined),
      } as Agent),
    });
    const registry = createRegistry([askUserTool]);
    mockToolCallStream([{ toolCallId: "ask-fail", toolName: "ask_user", input: {
      questions: [{ header: "Bridge", question: "Continue?", options: [], custom: true }],
    } }]);

    await runQueryLoop(fixture.options(registry, ["ask_user"]), "ask");
    const pending = await singlePendingHitl(fixture);

    await fixture.coordinator.respond(identity(pending), { type: "question_answer", answers: ["yes"] });
    await waitFor(async () => (await fixture.hitl.lookup(identity(pending))).status === "found" && ((await fixture.hitl.lookup(identity(pending))) as { record: HitlRecord }).record.status === "resume_failed");

    expect(attachSessionEvents).toHaveBeenCalledTimes(1);
    expect(detachSessionEvents).toHaveBeenCalledTimes(1);
  });

  test("abort signal spans durable replay and continuation and preserves the checkpoint", async () => {
    const abortController = new AbortController();
    const release = mock(() => undefined);
    let continuationStarted!: () => void;
    const started = new Promise<void>((resolve) => { continuationStarted = resolve; });
    let observedSignal: AbortSignal | undefined;
    const fixture = await createFixture({
      acquireSessionHitlResume: () => ({
        generation: Symbol("abortable-resume"),
        abortSignal: abortController.signal,
        acquireSessionCwdTransition: () => () => undefined,
        release,
      }),
      getAgent: ({ store }) => ({
        store,
        cwd: store.getState().cwd,
        run: mock(async (_message: string, options?: AgentRunOptions | AbortSignal) => {
          observedSignal = options instanceof AbortSignal ? options : options?.abort;
          continuationStarted();
          if (!observedSignal?.aborted) {
            await new Promise<void>((resolve) => observedSignal?.addEventListener("abort", () => resolve(), { once: true }));
          }
          return { text: "", steps: 0 };
        }),
        dispose: () => undefined,
      } as Agent),
    });
    const registry = createRegistry([askUserTool]);
    mockToolCallStream([{ toolCallId: "ask-abort", toolName: "ask_user", input: {
      questions: [{ header: "Abort", question: "Continue?", options: [], custom: true }],
    } }]);
    await runQueryLoop(fixture.options(registry, ["ask_user"]), "ask");
    const pending = await singlePendingHitl(fixture);

    await fixture.coordinator.respond(identity(pending), { type: "question_answer", answers: ["yes"] });
    await started;
    expect(observedSignal).toBe(abortController.signal);
    abortController.abort(new Error("Session cancelled"));
    await waitFor(async () => {
      const found = await fixture.hitl.lookup(identity(pending));
      return found.status === "found" && found.record.status === "resume_failed";
    });

    expect(release).toHaveBeenCalledTimes(1);
    expect((await readSessionHitlCheckpointFile(fixture.workspaceRoot, fixture.sessionId)).checkpoints)
      .toHaveLength(1);
    expect(fixture.store.getState().blockedByHitlIds).toEqual([pending.hitlId]);
  });

  test("cold-loads a child Session root before synchronously claiming HITL resume ownership", async () => {
    const rootSessionId = crypto.randomUUID();
    let fixture!: Awaited<ReturnType<typeof createFixture>>;
    let acquisitionObserved = false;
    fixture = await createFixture({
      sessionIdentity: {
        rootSessionId,
        parentSessionId: rootSessionId,
        agentName: "explore",
      },
      acquireSessionHitlResume: (workspaceRoot) => {
        expect(fixture.sessions.get(rootSessionId, workspaceRoot)).toBeDefined();
        acquisitionObserved = true;
        return createTestResumeLease();
      },
    });
    fixture.sessions.create(rootSessionId, fixture.workspaceRoot, { agentName: "orchestrator" });
    const registry = createRegistry([askUserTool]);
    mockToolCallStream([{ toolCallId: "ask-child-cold-root", toolName: "ask_user", input: {
      questions: [{ header: "Child", question: "Continue child?", options: [], custom: true }],
    } }]);
    await runQueryLoop(fixture.options(registry, ["ask_user"]), "ask from child");
    const pending = await singlePendingHitl(fixture);
    await waitFor(async () => await Bun.file(getSessionPath(fixture.workspaceRoot, rootSessionId)).exists());

    fixture.sessions.releaseWorkspace(fixture.workspaceRoot);
    expect(fixture.sessions.get(rootSessionId, fixture.workspaceRoot)).toBeUndefined();
    expect(fixture.sessions.get(fixture.sessionId, fixture.workspaceRoot)).toBeUndefined();

    await fixture.coordinator.respond(identity(pending), { type: "question_answer", answers: ["yes"] });
    await waitFor(() => acquisitionObserved);
    expect(fixture.sessions.get(rootSessionId, fixture.workspaceRoot)).toBeDefined();
    expect(fixture.sessions.get(fixture.sessionId, fixture.workspaceRoot)).toBeDefined();
  });

  test("explicit cancel clears a blocked child after its root changed cwd", async () => {
    const rootSessionId = crypto.randomUUID();
    const continueAgent = mock(async () => ({ text: "must not continue", steps: 0 }));
    let executionManager!: SessionExecutionManager;
    const fixture = await createFixture({
      sessionIdentity: {
        rootSessionId,
        parentSessionId: rootSessionId,
        agentName: "explore",
      },
      getAgent: ({ store }) => ({ store, cwd: store.getState().cwd, run: continueAgent, dispose: mock(() => undefined) } as Agent),
      acquireSessionHitlResume: (workspaceRoot, sessionId, options) => (
        executionManager.acquireSessionHitlResume(workspaceRoot, sessionId, options)
      ),
    });
    fixture.sessions.create(rootSessionId, fixture.workspaceRoot, { agentName: "orchestrator" });
    await fixture.sessions.flushSession(rootSessionId, fixture.workspaceRoot);
    executionManager = createResumeExecutionManager(fixture.sessions);
    const registry = createRegistry([askUserTool]);
    mockToolCallStream([{ toolCallId: "ask-stale-child-cancel", toolName: "ask_user", input: {
      questions: [{ header: "Cancel", question: "Cancel this stale child request?", options: [], custom: true }],
    } }]);
    await runQueryLoop(fixture.options(registry, ["ask_user"]), "ask from child before root moves");
    const pending = await singlePendingHitl(fixture);
    const nextRootCwd = join(fixture.workspaceRoot, "..", "root-moved-worktree");
    await mkdir(nextRootCwd, { recursive: true });
    await fixture.sessions.updateCwd(rootSessionId, fixture.workspaceRoot, nextRootCwd, fixture.workspaceRoot);

    await fixture.coordinator.cancel(identity(pending), "Root moved; discard the dormant child request");
    await waitFor(async () => {
      const found = await fixture.hitl.lookup(identity(pending));
      return found.status === "found" && found.record.status === "cancelled";
    });

    expect(continueAgent).not.toHaveBeenCalled();
    const coldSessions = new SessionStoreManager({ logger: silentLogger });
    expect((await coldSessions.getOrLoad(fixture.sessionId, fixture.workspaceRoot)).getState().blockedByHitlIds).toBeUndefined();
  });

  test("claims Session ownership before asynchronously reading the durable checkpoint", async () => {
    let executionManager!: SessionExecutionManager;
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalReadStarted = resolve; });
    let allowRead!: () => void;
    const readAllowed = new Promise<void>((resolve) => { allowRead = resolve; });
    const fixture = await createFixture({
      acquireSessionHitlResume: (workspaceRoot, sessionId) => (
        executionManager.acquireSessionHitlResume(workspaceRoot, sessionId)
      ),
      readCheckpoint: async (workspaceRoot, sessionId, hitlId) => {
        signalReadStarted();
        await readAllowed;
        return await readSessionHitlCheckpoint(workspaceRoot, sessionId, hitlId);
      },
    });
    executionManager = createResumeExecutionManager(fixture.sessions);
    const registry = createRegistry([askUserTool]);
    mockToolCallStream([{ toolCallId: "ask-checkpoint-race", toolName: "ask_user", input: {
      questions: [{ header: "Race", question: "Continue?", options: [], custom: true }],
    } }]);
    await runQueryLoop(fixture.options(registry, ["ask_user"]), "pause");
    const pending = await singlePendingHitl(fixture);

    await fixture.coordinator.respond(identity(pending), { type: "question_answer", answers: ["yes"] });
    await readStarted;

    expect(executionManager.isRunning(fixture.workspaceRoot, fixture.sessionId)).toBe(true);
    await expect(executionManager.startCheckedExecution({
      slug: "archcode",
      workspaceRoot: fixture.workspaceRoot,
      sessionId: fixture.sessionId,
      userMessage: "must not overtake checkpoint replay",
    })).rejects.toThrow(SessionHitlBlockedError);

    allowRead();
    await waitFor(async () => {
      const found = await fixture.hitl.lookup(identity(pending));
      return found.status === "found" && found.record.status === "resolved";
    });
    expect(executionManager.isRunning(fixture.workspaceRoot, fixture.sessionId)).toBe(false);
  });

  test("permission response is durably claimed before restart resume executes the blocked tool once", async () => {
    const fixture = await createFixture();
    const execute = mock(async () => "mutated");
    const registry = createRegistry([guardedTool("mutate", execute)]);
    mockToolCallStream([{ toolCallId: "perm-1", toolName: "mutate", input: { message: "raw secret value" } }]);

    const loop = await fixture.loopState.create("archcode", {
      templateId: "watch_report",
      title: null,
      schedule: { kind: "manual" },
      approvalPolicy: "interactive",
      limits: { maxIterationsPerRun: 8, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
      taskPrompt: "Resume the guarded tool",
      useWorktree: false,
    });
    fixture.store.setState({ loopId: loop.loopId });
    const loopOrigin = {
      kind: "loop" as const,
      loopId: loop.loopId,
      runId: "run-1",
      trigger: "manual" as const,
      approvalPolicy: "interactive" as const,
    };

    await runQueryLoop({ ...fixture.options(registry, ["mutate"]), origin: loopOrigin }, "mutate");

    const pending = await singlePendingHitl(fixture);
    expect((await readSessionHitlCheckpointFile(fixture.workspaceRoot, fixture.sessionId)).checkpoints[0]?.origin).toEqual(loopOrigin);
    const restarted = await recreateResumeRuntime(fixture, registry, {
      acquire: async () => ({ complete: async () => undefined, fail: async () => undefined }),
    });
    const claimed = await restarted.coordinator.respond(identity(pending), { type: "permission_decision", decision: "approve_once" });
    expect(claimed).toMatchObject({ status: "claimed", scheduled: true, record: { status: "resume_claimed" } });
    await waitFor(async () => execute.mock.calls.length === 1);
    await waitFor(async () => (await restarted.hitl.lookup(identity(pending))).status === "found" && ((await restarted.hitl.lookup(identity(pending))) as { record: HitlRecord }).record.status === "resolved");

    expect(execute).toHaveBeenCalledTimes(1);
    const resumedStore = await restarted.sessions.getOrLoad(fixture.sessionId, fixture.workspaceRoot);
    expect(latestToolPart(resumedStore.getState().messages, "perm-1")).toMatchObject({ state: "completed", output: "mutated" });
  });

  test("cold replay never repeats an effectful tool whose durable attempt has unknown outcome", async () => {
    const fixture = await createFixture();
    const execute = mock(async () => "effect applied");
    const registry = createRegistry([guardedTool("effect_once", execute)]);
    mockToolCallStream([{ toolCallId: "effect-once-1", toolName: "effect_once", input: {} }]);
    await runQueryLoop(fixture.options(registry, ["effect_once"]), "effect once");
    const pending = await singlePendingHitl(fixture);

    fixture.store.getState().append({
      type: "tool-attempt",
      toolCallId: "effect-once-1",
      toolName: "effect_once",
      attemptId: "durable-attempt-before-crash",
      timestamp: Date.now(),
      destructive: true,
    });
    await fixture.sessions.flushSession(fixture.sessionId, fixture.workspaceRoot);
    await execute(); // The external effect happened, then the process died before recording its result.

    const restarted = await recreateResumeRuntime(fixture, registry);
    await restarted.coordinator.respond(identity(pending), { type: "permission_decision", decision: "approve_once" });
    await waitFor(async () => {
      const found = await restarted.hitl.lookup(identity(pending));
      return found.status === "found" && found.record.status === "resolved";
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const resumedStore = await restarted.sessions.getOrLoad(fixture.sessionId, fixture.workspaceRoot);
    expect(latestToolPart(resumedStore.getState().messages, "effect-once-1")).toMatchObject({
      state: "error",
      meta: { unknownResult: true },
    });
    expect(JSON.stringify(latestToolPart(resumedStore.getState().messages, "effect-once-1")))
      .toContain("Tool execution result unknown");
  });

  test("cold replay reuses a durable effectful error result without repeating its side effect", async () => {
    const fixture = await createFixture();
    let effects = 0;
    const execute = mock(async () => {
      effects += 1;
      return { output: "effect happened before the reported failure", isError: true };
    });
    const registry = createRegistry([defineTool({
      name: "effect_then_error",
      description: "Apply an effect and return an error result",
      inputSchema: z.object({}).strict(),
      traits: { readOnly: false, destructive: true, concurrencySafe: false },
      permissions: [async () => ({ outcome: "ask", reason: "Approve the effect" })],
      execute,
    })]);
    mockToolCallStream([{ toolCallId: "effect-error-1", toolName: "effect_then_error", input: {} }]);
    await runQueryLoop(fixture.options(registry, ["effect_then_error"]), "effect then error");
    const pending = await singlePendingHitl(fixture);

    fixture.store.getState().append({
      type: "tool-attempt",
      toolCallId: "effect-error-1",
      toolName: "effect_then_error",
      attemptId: "durable-error-attempt",
      timestamp: Date.now(),
      destructive: true,
    });
    await fixture.sessions.flushSession(fixture.sessionId, fixture.workspaceRoot);
    const firstResult = await execute();
    fixture.store.getState().append({
      type: "tool-result",
      toolCallId: "effect-error-1",
      toolName: "effect_then_error",
      output: firstResult.output,
      isError: true,
    });
    await fixture.sessions.flushSession(fixture.sessionId, fixture.workspaceRoot);

    const restarted = await recreateResumeRuntime(fixture, registry);
    await restarted.coordinator.respond(identity(pending), { type: "permission_decision", decision: "approve_once" });
    await waitFor(async () => {
      const found = await restarted.hitl.lookup(identity(pending));
      return found.status === "found" && found.record.status === "resolved";
    });

    expect(effects).toBe(1);
    const resumedStore = await restarted.sessions.getOrLoad(fixture.sessionId, fixture.workspaceRoot);
    expect(latestToolPart(resumedStore.getState().messages, "effect-error-1")).toMatchObject({
      state: "error",
      errorMessage: "effect happened before the reported failure",
    });
  });

  test("cold recovery never starts a second LLM continuation after the first continuation outcome became unknown", async () => {
    let continuationRuns = 0;
    const fixture = await createFixture({
      getAgent: ({ store }) => ({
        store,
        cwd: store.getState().cwd,
        run: mock(async () => {
          continuationRuns += 1;
          throw new Error("simulated crash after continuation side effect");
        }),
        dispose: mock(() => undefined),
      } as Agent),
    });
    const registry = createRegistry([askUserTool]);
    mockToolCallStream([{ toolCallId: "ask-continuation-crash", toolName: "ask_user", input: {
      questions: [{ header: "Continue", question: "Continue?", options: [], custom: true }],
    } }]);
    await runQueryLoop(fixture.options(registry, ["ask_user"]), "pause before continuation");
    const pending = await singlePendingHitl(fixture);

    await fixture.coordinator.respond(identity(pending), { type: "question_answer", answers: ["yes"] });
    await waitFor(async () => {
      const found = await fixture.hitl.lookup(identity(pending));
      return found.status === "found" && found.record.status === "resume_failed";
    });
    expect(continuationRuns).toBe(1);

    await fixture.coordinator.recover();
    await waitFor(async () => {
      const found = await fixture.hitl.lookup(identity(pending));
      return found.status === "found"
        && found.record.status === "resume_failed"
        && (found.record.resume?.attempt ?? 0) >= 2;
    });

    expect(continuationRuns).toBe(1);
    const checkpoint = await readSessionHitlCheckpoint(fixture.workspaceRoot, fixture.sessionId, pending.hitlId);
    expect(checkpoint === undefined ? undefined : sessionHitlJournalPhase(checkpoint)).toBe("manual_unknown");

    await fixture.coordinator.cancel(identity(pending), "Inspected external state; acknowledge unknown continuation");
    await waitFor(async () => {
      const found = await fixture.hitl.lookup(identity(pending));
      return found.status === "found" && found.record.status === "cancelled";
    });
    expect(continuationRuns).toBe(1);
    expect(await readSessionHitlCheckpoint(fixture.workspaceRoot, fixture.sessionId, pending.hitlId)).toBeUndefined();
    const coldSessions = new SessionStoreManager({ logger: silentLogger });
    const coldStore = await coldSessions.getOrLoad(fixture.sessionId, fixture.workspaceRoot);
    expect(coldStore.getState().blockedByHitlIds).toBeUndefined();
  });

  test("cancelling an unknown Loop-origin continuation clears the Session blocker after the Loop is terminal", async () => {
    const acquire = mock(async () => {
      throw new Error("Loop continuation must not be acquired for an unknown outcome cancellation");
    });
    const validate = mock(async () => {
      throw new Error("Terminal Loop execution scope is no longer runnable");
    });
    const fixture = await createFixture({
      loopContinuation: { acquire },
      executionScopeValidator: { validate },
    });
    const loop = await fixture.loopState.create("archcode", {
      templateId: "watch_report",
      title: null,
      schedule: { kind: "manual" },
      approvalPolicy: "interactive",
      limits: { maxIterationsPerRun: 3, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
      useWorktree: false,
    });
    fixture.store.setState({ loopId: loop.loopId });
    const jobQueue = new LoopJobQueue({ workspaceRoot: fixture.workspaceRoot, clock: { now: () => 1_000 } });
    const jobCoordinator = new LoopJobCoordinator({
      queue: jobQueue,
      clock: { now: () => 1_000 },
      incarnationId: "unknown-loop-continuation-test",
    });
    const enqueued = await jobQueue.enqueue({
      loopId: loop.loopId,
      triggerKind: "manual",
      subjectKey: `manual:${loop.loopId}`,
    });
    const claimed = (await jobCoordinator.dispatchReady())[0]!;
    const runId = crypto.randomUUID();
    const runningReport = {
      runId,
      loopId: loop.loopId,
      status: "running" as const,
      trigger: "manual" as const,
      startedAt: 1_000,
      jobId: claimed.jobId,
      subjectKey: claimed.subjectKey,
      sessionId: fixture.sessionId,
    };
    await fixture.loopState.recordRunStart(loop.loopId, runningReport);

    const registry = createRegistry([askUserTool]);
    const origin = {
      kind: "loop" as const,
      loopId: loop.loopId,
      runId,
      trigger: "manual" as const,
      approvalPolicy: "interactive" as const,
    };
    mockToolCallStream([{ toolCallId: "ask-unknown-loop-continuation", toolName: "ask_user", input: {
      questions: [{ header: "Continue", question: "Continue Loop?", options: [], custom: true }],
    } }]);
    await runQueryLoop({ ...fixture.options(registry, ["ask_user"]), origin }, "pause Loop Session");
    const pending = await singlePendingHitl(fixture);
    const blockedReport = {
      ...runningReport,
      status: "needs_user" as const,
      endedAt: 1_000,
      blockedReason: "needs_user",
      blockedByHitlIds: [pending.hitlId],
      attentionStatus: "waiting_for_human" as const,
      resumeCheckpoint: {
        version: 1 as const,
        hitlId: pending.hitlId,
        loopId: loop.loopId,
        runId,
        jobId: claimed.jobId,
        trigger: "manual" as const,
        subjectKey: claimed.subjectKey,
        intendedContinuation: "resume_run" as const,
      },
      summary: "Session is waiting for user input.",
    };
    await fixture.loopState.recordRunBlocked(loop.loopId, blockedReport);
    await jobCoordinator.finish(claimed.jobId, {
      leaseOwnerId: claimed.leaseOwnerId!,
      leaseToken: claimed.leaseToken!,
    }, {
      status: "needs_user",
      blockedReason: "needs_user",
      blockedByHitlIds: [pending.hitlId],
      attentionStatus: "waiting_for_human",
      resumeCheckpoint: blockedReport.resumeCheckpoint,
    });
    await transitionSessionHitlJournalPhase(fixture.workspaceRoot, fixture.sessionId, pending.hitlId, "replaying");
    await transitionSessionHitlJournalPhase(fixture.workspaceRoot, fixture.sessionId, pending.hitlId, "continuing");
    await fixture.loopState.recordRunFinish(loop.loopId, {
      ...blockedReport,
      status: "cancelled",
      endedAt: 990,
      reason: "cancelled_by_user",
      blockedReason: "cancelled_by_user",
      blockedByHitlIds: undefined,
      attentionStatus: "clear",
    });
    await fixture.loopState.clearHitlBlocker(loop.loopId, pending.hitlId);
    await jobQueue.update(enqueued.job.jobId, {
      status: "cancelled",
      endedAt: 990,
      blockedReason: "cancelled_by_user",
      blockedByHitlIds: undefined,
      attentionStatus: "clear",
      resumeCheckpoint: undefined,
    });

    await fixture.coordinator.cancel(identity(pending), "Acknowledge unknown Session continuation outcome");
    await waitFor(async () => {
      const found = await fixture.hitl.lookup(identity(pending));
      return found.status === "found" && found.record.status === "cancelled";
    });

    expect(acquire).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(await jobQueue.read(enqueued.job.jobId)).toMatchObject({
      status: "cancelled",
      attentionStatus: "clear",
    });
    expect(await fixture.loopState.read(loop.loopId)).toMatchObject({
      lastRun: { status: "cancelled", reason: "cancelled_by_user" },
      attentionStatus: "clear",
    });
    expect((await fixture.loopState.read(loop.loopId)).currentRun).toBeUndefined();
    const coldSessions = new SessionStoreManager({ logger: silentLogger });
    expect((await coldSessions.getOrLoad(fixture.sessionId, fixture.workspaceRoot)).getState().blockedByHitlIds).toBeUndefined();
  });

  test("explicit cancel clears a Session blocker after its persisted worktree cwd is removed", async () => {
    const continueAgent = mock(async () => ({ text: "must not run", steps: 0 }));
    const fixture = await createFixture({
      getAgent: ({ store }) => ({
        store,
        cwd: store.getState().cwd,
        run: continueAgent,
        dispose: mock(() => undefined),
      } as Agent),
    });
    const removedWorktree = join(fixture.workspaceRoot, ".archcode", "worktrees", "removed-session-worktree");
    await mkdir(removedWorktree, { recursive: true });
    await fixture.sessions.updateCwd(fixture.sessionId, fixture.workspaceRoot, removedWorktree, fixture.workspaceRoot);
    const registry = createRegistry([askUserTool]);
    mockToolCallStream([{ toolCallId: "ask-removed-worktree-cancel", toolName: "ask_user", input: {
      questions: [{ header: "Cancel", question: "Cancel stale worktree request?", options: [], custom: true }],
    } }]);
    await runQueryLoop({ ...fixture.options(registry, ["ask_user"]), cwd: removedWorktree }, "pause before worktree removal");
    const pending = await singlePendingHitl(fixture);
    await rm(removedWorktree, { recursive: true, force: true });

    await fixture.coordinator.cancel(identity(pending), "Worktree no longer exists");
    await waitFor(async () => {
      const found = await fixture.hitl.lookup(identity(pending));
      return found.status === "found" && found.record.status === "cancelled";
    });

    expect(continueAgent).not.toHaveBeenCalled();
    expect(await readSessionHitlCheckpoint(fixture.workspaceRoot, fixture.sessionId, pending.hitlId)).toBeUndefined();
    const coldSessions = new SessionStoreManager({ logger: silentLogger });
    const coldStore = await coldSessions.getOrLoad(fixture.sessionId, fixture.workspaceRoot);
    expect(coldStore.getState().cwd).toBe(removedWorktree);
    expect(coldStore.getState().blockedByHitlIds).toBeUndefined();
  });

  test("cold replay skips the model when the durable journal proves continuation completed", async () => {
    let continuationRuns = 0;
    const fixture = await createFixture({
      getAgent: ({ store }) => ({
        store,
        cwd: store.getState().cwd,
        run: mock(async () => {
          continuationRuns += 1;
          return { text: "must not run", steps: 0 };
        }),
        dispose: mock(() => undefined),
      } as Agent),
    });
    const registry = createRegistry([askUserTool]);
    mockToolCallStream([{ toolCallId: "ask-already-continued", toolName: "ask_user", input: {
      questions: [{ header: "Continue", question: "Continue?", options: [], custom: true }],
    } }]);
    await runQueryLoop(fixture.options(registry, ["ask_user"]), "pause before completed continuation checkpoint");
    const pending = await singlePendingHitl(fixture);
    await transitionSessionHitlJournalPhase(fixture.workspaceRoot, fixture.sessionId, pending.hitlId, "replaying");
    await transitionSessionHitlJournalPhase(fixture.workspaceRoot, fixture.sessionId, pending.hitlId, "continuing");
    await transitionSessionHitlJournalPhase(fixture.workspaceRoot, fixture.sessionId, pending.hitlId, "continued");

    await fixture.coordinator.respond(identity(pending), { type: "question_answer", answers: ["yes"] });
    await waitFor(async () => {
      const found = await fixture.hitl.lookup(identity(pending));
      return found.status === "found" && found.record.status === "resolved";
    });

    expect(continuationRuns).toBe(0);
    expect(await readSessionHitlCheckpoint(fixture.workspaceRoot, fixture.sessionId, pending.hitlId)).toBeUndefined();
  });

  test("rejects Loop HITL replay when the checkpoint origin does not match the Session owner", async () => {
    const fixture = await createFixture();
    const loop = await fixture.loopState.create("archcode", {
      templateId: "watch_report",
      title: null,
      schedule: { kind: "manual" },
      approvalPolicy: "interactive",
      limits: { maxIterationsPerRun: 8, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
      taskPrompt: "Resume only inside this Loop",
      useWorktree: false,
    });
    fixture.store.setState({ loopId: loop.loopId });
    const execute = mock(async () => "must not run");
    const registry = createRegistry([guardedTool("loop-mutate", execute)]);
    mockToolCallStream([{ toolCallId: "loop-perm", toolName: "loop-mutate", input: {} }]);
    await runQueryLoop(fixture.options(registry, ["loop-mutate"]), "pause without Loop origin");
    const pending = await singlePendingHitl(fixture);

    await expect(fixture.adapter(registry).resume(pending, {
      type: "permission_decision",
      decision: "approve_once",
    })).rejects.toMatchObject({
      name: "SessionExecutionScopeConflictError",
      code: "SESSION_LOOP_HITL_ORIGIN_MISMATCH",
    } satisfies Partial<SessionExecutionScopeConflictError>);

    expect(execute).not.toHaveBeenCalled();
    expect(await readSessionHitlCheckpoint(fixture.workspaceRoot, fixture.sessionId, pending.hitlId)).toBeDefined();
  });

  test("chained Session HITL pause from continuation preserves the new blocker", async () => {
    const fixture = await createFixture({
      getAgent: ({ store, hitl, workspaceRoot, sessionId }) => ({
        store,
        cwd: store.getState().cwd,
        run: mock(async () => {
          const next = await hitl.create({
            owner: { projectSlug: "archcode", ownerType: "session", ownerId: sessionId },
            blockingKey: `session:${sessionId}:ask:ask-next`,
            source: { type: "ask_user", sessionId, toolCallId: "ask-next" },
            displayPayload: { title: "Next question", summary: "Continue?", redacted: true },
          });
          const checkpointCreatedAt = new Date().toISOString();
          await writeSessionHitlCheckpoint({
            version: 1,
            phase: "paused",
            phaseUpdatedAt: checkpointCreatedAt,
            hitlId: next.hitlId,
            blockingKey: next.blockingKey,
            source: next.source,
            request: {
              owner: next.owner,
              displayPayload: next.displayPayload,
              createdAt: next.createdAt,
            },
            toolCallId: "ask-next",
            toolName: "ask_user",
            step: 1,
            rawToolInput: { questions: [{ header: "Next", question: "Continue?", options: [], custom: true }] },
            displayInput: { questions: [{ header: "Next", question: "Continue?", options: [], custom: true }] },
            allowedTools: ["ask_user"],
            agentSkills: [],
            agentName: "orchestrator",
            toolCalls: [{ toolCallId: "ask-next", toolName: "ask_user", input: { questions: [{ header: "Next", question: "Continue?", options: [], custom: true }] } }],
            completedToolResults: [],
            pendingToolCalls: [{ toolCallId: "ask-next", toolName: "ask_user", input: { questions: [{ header: "Next", question: "Continue?", options: [], custom: true }] } }],
            blockedToolIndex: 0,
            createdAt: checkpointCreatedAt,
            kind: "ask_user",
          }, workspaceRoot, sessionId);
          store.getState().append({ type: "hitl.request", request: next });
          store.getState().append({
            type: "execution-end",
            status: "waiting_for_human",
            blockedByHitlIds: [next.hitlId],
            blockedToolCallId: "ask-next",
            blockedHitl: {
              version: 1,
              hitlId: next.hitlId,
              blockingKey: next.blockingKey,
              source: next.source,
              toolCallId: "ask-next",
              toolName: "ask_user",
              step: 1,
              displayInput: { questions: [{ header: "Next", question: "Continue?", options: [], custom: true }] },
              blockedAt: new Date().toISOString(),
              reason: "Next question",
            },
          });
          return { text: "", steps: 0 };
        }),
        dispose: mock(() => undefined),
      } as Agent),
    });
    const execute = mock(async () => "first mutation");
    const registry = createRegistry([guardedTool("mutate", execute)]);
    mockToolCallStream([{ toolCallId: "perm-chain", toolName: "mutate", input: { message: "raw old" } }]);

    await runQueryLoop(fixture.options(registry, ["mutate"]), "chain");
    const oldPending = await singlePendingHitl(fixture);
    await fixture.coordinator.respond(identity(oldPending), { type: "permission_decision", decision: "approve_once" });
    await waitFor(async () => (await fixture.hitl.lookup(identity(oldPending))).status === "found" && ((await fixture.hitl.lookup(identity(oldPending))) as { record: HitlRecord }).record.status === "resolved");

    const state = fixture.store.getState();
    const nextHitlId = state.blockedHitl?.hitlId;
    if (nextHitlId === undefined) throw new Error("Expected chained HITL blocker");
    expect(nextHitlId).not.toBe(oldPending.hitlId);
    expect(state.blockedByHitlIds).toEqual([nextHitlId]);
    expect(state.blockedHitl).toMatchObject({ hitlId: nextHitlId, toolCallId: "ask-next", toolName: "ask_user" });
    const checkpointFile = await readSessionHitlCheckpointFile(fixture.workspaceRoot, fixture.sessionId);
    expect(checkpointFile.checkpoints.map((checkpoint) => checkpoint.hitlId)).toEqual([nextHitlId]);
  });

  test("permission denial and cancel resume stable original toolCallId errors without executing tool", async () => {
    const denied = await createFixture();
    const deniedExecute = mock(async () => "should not run");
    const deniedRegistry = createRegistry([guardedTool("mutate", deniedExecute)]);
    mockToolCallStream([{ toolCallId: "perm-deny", toolName: "mutate", input: { message: "deny secret" } }]);
    await runQueryLoop(denied.options(deniedRegistry, ["mutate"]), "deny");

    const deniedPending = await singlePendingHitl(denied);
    await denied.coordinator.respond(identity(deniedPending), { type: "permission_decision", decision: "deny" });
    await waitFor(async () => (await denied.hitl.lookup(identity(deniedPending))).status === "found" && ((await denied.hitl.lookup(identity(deniedPending))) as { record: HitlRecord }).record.status === "resolved");

    const deniedTool = latestToolPart(denied.store.getState().messages, "perm-deny");
    expect(deniedExecute).not.toHaveBeenCalled();
    expect(deniedTool).toMatchObject({ state: "error", toolCallId: "perm-deny", toolName: "mutate" });
    expect(JSON.stringify(deniedTool)).toContain("TOOL_PERMISSION_CONFIRMATION_DENIED");

    const cancelled = await createFixture();
    const cancelExecute = mock(async () => "should not run");
    const cancelRegistry = createRegistry([guardedTool("mutate", cancelExecute)]);
    mockToolCallStream([{ toolCallId: "perm-cancel", toolName: "mutate", input: { message: "cancel secret" } }]);
    await runQueryLoop(cancelled.options(cancelRegistry, ["mutate"]), "cancel");

    const cancelPending = await singlePendingHitl(cancelled);
    await cancelled.coordinator.cancel(identity(cancelPending), "User cancelled");
    await waitFor(async () => (await cancelled.hitl.lookup(identity(cancelPending))).status === "found" && ((await cancelled.hitl.lookup(identity(cancelPending))) as { record: HitlRecord }).record.status === "cancelled");

    const cancelledTool = latestToolPart(cancelled.store.getState().messages, "perm-cancel");
    expect(cancelExecute).not.toHaveBeenCalled();
    expect(cancelledTool).toMatchObject({ state: "error", toolCallId: "perm-cancel", toolName: "mutate" });
    expect(JSON.stringify(cancelledTool)).toContain("TOOL_CANCELLED");
  });

  test("permission resume fails closed when checkpoint blocked tool is missing", async () => {
    const fixture = await createFixture();
    const execute = mock(async () => "should not run");
    const registry = createRegistry([
      guardedTool("blocked", execute),
      guardedTool("later", execute, { ask: false }),
    ]);
    mockToolCallStream([
      { toolCallId: "perm-missing", toolName: "blocked", input: { message: "raw should stay checkpoint-only" } },
      { toolCallId: "later-after-missing", toolName: "later", input: {} },
    ]);
    await runQueryLoop(fixture.options(registry, ["blocked", "later"]), "invalid checkpoint");

    const pending = await singlePendingHitl(fixture);
    const checkpoint = (await readSessionHitlCheckpointFile(fixture.workspaceRoot, fixture.sessionId)).checkpoints[0]!;
    await writeSessionHitlCheckpoint({ ...checkpoint, pendingToolCalls: checkpoint.pendingToolCalls.slice(1) }, fixture.workspaceRoot, fixture.sessionId);

    await fixture.coordinator.respond(identity(pending), { type: "permission_decision", decision: "approve_once" });
    await waitFor(async () => (await fixture.hitl.lookup(identity(pending))).status === "found" && ((await fixture.hitl.lookup(identity(pending))) as { record: HitlRecord }).record.status === "resolved");

    expect(execute).not.toHaveBeenCalled();
    const failedTool = latestToolPart(fixture.store.getState().messages, "perm-missing");
    expect(failedTool).toMatchObject({ state: "error", toolCallId: "perm-missing", toolName: "blocked" });
    expect(JSON.stringify(failedTool)).toContain("SESSION_HITL_CHECKPOINT_INVALID");
    expect(latestToolPart(fixture.store.getState().messages, "later-after-missing")).toMatchObject({
      state: "error",
      toolCallId: "later-after-missing",
      toolName: "later",
    });
  });

  test("multi-tool HITL checkpoint preserves ordered batch and does not start later effectful tool before response", async () => {
    const fixture = await createFixture();
    const events: string[] = [];
    const registry = createRegistry([
      defineTool({
        name: "first",
        description: "First safe tool",
        inputSchema: z.object({}).strict(),
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        execute: async () => {
          events.push("execute:first");
          return "first ok";
        },
      }),
      guardedTool("blocked", async () => {
        events.push("execute:blocked");
        return "blocked ok";
      }),
      guardedTool("later", async () => {
        events.push("execute:later");
        return "later ok";
      }, { ask: false }),
    ]);
    mockToolCallStream([
      { toolCallId: "tc-first", toolName: "first", input: {} },
      { toolCallId: "tc-blocked", toolName: "blocked", input: {} },
      { toolCallId: "tc-later", toolName: "later", input: {} },
    ]);

    await runQueryLoop(fixture.options(registry, ["first", "blocked", "later"]), "multi");

    expect(events).toEqual(["execute:first"]);
    const pending = await singlePendingHitl(fixture);
    const checkpoint = (await readSessionHitlCheckpointFile(fixture.workspaceRoot, fixture.sessionId)).checkpoints[0]!;
    expect(checkpoint.toolCalls.map((call) => call.toolCallId)).toEqual(["tc-first", "tc-blocked", "tc-later"]);
    expect(checkpoint.completedToolResults.map((result) => result.toolCallId)).toEqual(["tc-first"]);
    expect(checkpoint.pendingToolCalls.map((call) => call.toolCallId)).toEqual(["tc-blocked", "tc-later"]);

    await fixture.coordinator.respond(identity(pending), { type: "permission_decision", decision: "approve_once" });
    await waitFor(() => events.includes("execute:later"));

    expect(events).toEqual(["execute:first", "execute:blocked", "execute:later"]);
    expect(latestToolPart(fixture.store.getState().messages, "tc-later")).toMatchObject({ state: "completed", output: "later ok" });
  });
});

async function createFixture(options: {
  readonly getAgent?: (input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly store: ReturnType<SessionStoreManager["create"]>;
    readonly hitl: HitlService;
  }) => Agent;
  readonly attachSessionEvents?: (workspaceRoot: string, sessionId: string, store: ReturnType<SessionStoreManager["create"]>) => void;
  readonly detachSessionEvents?: (workspaceRoot: string, sessionId: string) => void;
  readonly acquireSessionHitlResume?: (
    workspaceRoot: string,
    sessionId: string,
    options?: Parameters<SessionExecutionManager["acquireSessionHitlResume"]>[2],
  ) => SessionHitlResumeLease;
  readonly readCheckpoint?: (workspaceRoot: string, sessionId: string, hitlId: string) => ReturnType<typeof readSessionHitlCheckpoint>;
  readonly loopContinuation?: SessionLoopHitlContinuationCoordinator;
  readonly executionScopeValidator?: Pick<SessionExecutionScopeValidator, "validate">;
  readonly sessionIdentity?: {
    readonly rootSessionId: string;
    readonly parentSessionId: string;
    readonly agentName: string;
  };
} = {}) {
  const workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  const sessionId = crypto.randomUUID();
  const sessions = new SessionStoreManager({ logger: silentLogger });
  const store = sessions.create(sessionId, workspaceRoot, options.sessionIdentity);
  const goalState = new GoalStateManager(workspaceRoot, silentLogger);
  const loopState = new LoopStateManager(workspaceRoot, silentLogger);
  const hitl = new HitlService({ workspaceRoot, project: { slug: "archcode", name: "ArchCode" }, sessions, goalState, loopState });
  const approvals = new ProjectApprovalManager(silentLogger);
  await approvals.load(workspaceRoot);
  const projectContext: ProjectContext = {
    ...createTestProjectContext(workspaceRoot),
    project: { slug: "archcode", name: "ArchCode", workspaceRoot, addedAt: new Date().toISOString() },
    goalState,
    goalCancellation: { cancel: async (goalId, request) => await goalState.cancel(goalId, request.reason) },
    loopState,
    hitl,
    hitlResumeCoordinator: new ResumeCoordinator({ hitl, adapters: {} }),
    memory: new MemoryFileManager({ project: join(workspaceRoot, ".archcode", "memory"), user: join(workspaceRoot, ".archcode", "user-memory") }),
    approvals,
  };
  const resolver = createAliasedResolver(workspaceRoot, sessions, projectContext);
  const executionScopeValidator = options.executionScopeValidator ?? new SessionExecutionScopeValidator({
    projectContextResolver: resolver,
    loopExecutionClaimResolver: allowLoopExecutionClaims,
  });
  const adapter = (registry: ReturnType<typeof createRegistry>) => new SessionHitlResumeAdapter({
    workspaceRoot,
    storeManager: sessions,
    toolRegistry: registry,
    projectContextResolver: resolver,
    executionScopeValidator,
    skillService: testSkillService,
    acquireSessionHitlResume: options.acquireSessionHitlResume ?? (() => createTestResumeLease()),
    ...(options.loopContinuation === undefined ? {} : { loopContinuation: options.loopContinuation }),
    ...(options.readCheckpoint === undefined ? {} : { readCheckpoint: options.readCheckpoint }),
    getAgent: async () => options.getAgent?.({ workspaceRoot, sessionId, store, hitl }) ?? noOpAgent(store),
    ...(options.attachSessionEvents === undefined ? {} : { attachSessionEvents: options.attachSessionEvents }),
    ...(options.detachSessionEvents === undefined ? {} : { detachSessionEvents: options.detachSessionEvents }),
  });
  let currentRegistry = createRegistry();
  const coordinator = new ResumeCoordinator({
    hitl,
    adapters: {
      session: {
        resume: (record, response) => adapter(currentRegistry).resume(record, response),
        finalize: (record) => adapter(currentRegistry).finalize(record),
      },
    },
  });
  projectContext.hitlResumeCoordinator = coordinator;

  return {
    workspaceRoot,
    sessionId,
    sessions,
    store,
    hitl,
    loopState,
    coordinator,
    adapter,
    options(registry: ReturnType<typeof createRegistry>, allowedTools: string[]): QueryLoopOptions {
      currentRegistry = registry;
      return {
        modelInfo: dummyModelInfo,
        logger: silentLogger,
        toolRegistry: registry,
        allowedTools,
        agentName: "orchestrator",
        agentSkills: [],
        skillService: testSkillService,
        storeManager: sessions,
        cwd: workspaceRoot,
        projectContext,
        store,
      };
    },
  };
}

async function recreateResumeRuntime(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  registry: ReturnType<typeof createRegistry>,
  loopContinuation?: SessionLoopHitlContinuationCoordinator,
) {
  const sessions = new SessionStoreManager({ logger: silentLogger });
  const goalState = new GoalStateManager(fixture.workspaceRoot, silentLogger);
  const loopState = new LoopStateManager(fixture.workspaceRoot, silentLogger);
  const hitl = new HitlService({ workspaceRoot: fixture.workspaceRoot, project: { slug: "archcode", name: "ArchCode" }, sessions, goalState, loopState });
  const approvals = new ProjectApprovalManager(silentLogger);
  await approvals.load(fixture.workspaceRoot);
  const projectContext: ProjectContext = {
    ...createTestProjectContext(fixture.workspaceRoot),
    project: { slug: "archcode", name: "ArchCode", workspaceRoot: fixture.workspaceRoot, addedAt: new Date().toISOString() },
    goalState,
    goalCancellation: { cancel: async (goalId, request) => await goalState.cancel(goalId, request.reason) },
    loopState,
    hitl,
    hitlResumeCoordinator: new ResumeCoordinator({ hitl, adapters: {} }),
    memory: new MemoryFileManager({ project: join(fixture.workspaceRoot, ".archcode", "memory"), user: join(fixture.workspaceRoot, ".archcode", "user-memory") }),
    approvals,
  };
  const resolver = createAliasedResolver(fixture.workspaceRoot, sessions, projectContext);
  const executionScopeValidator = new SessionExecutionScopeValidator({
    projectContextResolver: resolver,
    loopExecutionClaimResolver: allowLoopExecutionClaims,
  });
  const adapter = new SessionHitlResumeAdapter({
    workspaceRoot: fixture.workspaceRoot,
    storeManager: sessions,
    toolRegistry: registry,
    projectContextResolver: resolver,
    executionScopeValidator,
    skillService: testSkillService,
    getAgent: async (_workspaceRoot, sessionId) => noOpAgent(await sessions.getOrLoad(sessionId, fixture.workspaceRoot)),
    acquireSessionHitlResume: () => createTestResumeLease(),
    ...(loopContinuation === undefined ? {} : { loopContinuation }),
  });
  const coordinator = new ResumeCoordinator({ hitl, adapters: { session: adapter } });
  projectContext.hitlResumeCoordinator = coordinator;
  return { sessions, hitl, coordinator };
}

function createTestResumeLease(): SessionHitlResumeLease {
  const abortController = new AbortController();
  return {
    generation: Symbol("test-session-hitl-resume"),
    abortSignal: abortController.signal,
    acquireSessionCwdTransition: () => () => undefined,
    release: () => undefined,
  };
}

function noOpAgent(store: ReturnType<SessionStoreManager["create"]>): Agent {
  return {
    store,
    cwd: store.getState().cwd,
    run: async () => ({ text: "", steps: 0 }),
    dispose: () => undefined,
  } as Agent;
}

function createAliasedResolver(
  workspaceRoot: string,
  sessions: SessionStoreManager,
  context: ProjectContext,
): ProjectContextResolver {
  const resolver = new ProjectContextResolver({
    projectInfoFactory: () => context.project,
    goalCancellationFactory: () => context.goalCancellation,
    sessionStoreManager: sessions,
    resumeCoordinatorFactory: () => context.hitlResumeCoordinator,
  });
  resolver.alias(workspaceRoot, context);
  return resolver;
}

function createResumeExecutionManager(sessions: SessionStoreManager): SessionExecutionManager {
  return new SessionExecutionManager({
    sessionAgentManager: {} as SessionAgentManager,
    createSessionStore: (sessionId, workspaceRoot, options) => sessions.create(sessionId, workspaceRoot, options),
    flushSessionStore: (sessionId, workspaceRoot) => sessions.flushSession(sessionId, workspaceRoot),
    getSessionStore: (sessionId, workspaceRoot) => sessions.get(sessionId, workspaceRoot),
    loadSessionStore: (sessionId, workspaceRoot) => sessions.getOrLoad(sessionId, workspaceRoot),
    deleteSessionStore: (sessionId, workspaceRoot, options) => sessions.delete(sessionId, workspaceRoot, options),
    resolveRootSessionId: (sessionId, workspaceRoot) => sessions.resolveRootSessionId(sessionId, workspaceRoot),
    buildSessionTree: (workspaceRoot, rootSessionId) => sessions.buildSessionTree(workspaceRoot, rootSessionId),
    trackSession: () => undefined,
    untrackSession: () => undefined,
    executionScopeValidator: { validate: async () => undefined },
    logger: silentLogger,
  });
}

function guardedTool(name: string, execute: (input: { message?: string }) => Promise<string>, options: { ask?: boolean } = {}) {
  return defineTool({
    name,
    description: `Guarded ${name}`,
    inputSchema: z.object({ message: z.string().optional() }).strict(),
    traits: { readOnly: false, destructive: true, concurrencySafe: false },
    permissions: [async () => options.ask === false ? { outcome: "allow" } : { outcome: "ask", reason: `Approve ${name}` }],
    execute,
  });
}

function mockToolCallStream(toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>) {
  const fn = mock(() => ({
    fullStream: (async function* () {
      for (const toolCall of toolCalls) yield { type: "tool-call" as const, ...toolCall };
    })(),
    finishReason: Promise.resolve("tool-calls"),
    usage: Promise.resolve({ totalTokens: 1 }),
    text: Promise.resolve(""),
    toolCalls: Promise.resolve(toolCalls),
  }));
  setLlmAdapterForTest({ streamText: fn as unknown as StreamTextFn });
}

async function singlePendingHitl(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<HitlRecord> {
  const file = await Bun.file(getSessionHitlPath(fixture.workspaceRoot, fixture.sessionId)).json() as { pending: HitlRecord[] };
  expect(file.pending).toHaveLength(1);
  return file.pending[0]!;
}

function latestToolPart(messages: Awaited<ReturnType<typeof createFixture>>["store"]["getState"] extends () => infer State ? State extends { messages: infer Messages } ? Messages : never : never, toolCallId: string) {
  for (const message of [...messages].reverse()) {
    for (const part of [...message.parts].reverse()) {
      if (part.type === "tool" && part.toolCallId === toolCallId) return part;
    }
  }
  throw new Error(`Missing tool part ${toolCallId}`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met");
}

async function initializeGitRepo(workspaceRoot: string): Promise<void> {
  await git(workspaceRoot, ["init", "--initial-branch=main"]);
  await git(workspaceRoot, ["config", "user.email", "session-hitl@example.com"]);
  await git(workspaceRoot, ["config", "user.name", "Session HITL"]);
  await writeFile(join(workspaceRoot, "README.md"), "# Session HITL\n");
  await git(workspaceRoot, ["add", "README.md"]);
  await git(workspaceRoot, ["commit", "-m", "initial commit"]);
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(process.stderr).text();
  if (await process.exited !== 0) throw new Error(stderr);
}
