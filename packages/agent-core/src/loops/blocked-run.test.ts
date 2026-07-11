import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats, type SessionEventEnvelope, type SessionExecutionRecord } from "@archcode/protocol";

import type { ActiveSessionExecution, SessionCwdReferenceMigrationInput, SessionCwdRemovalLifecycle, SessionCwdRemovalResult, StartSessionExecutionInput } from "../execution";
import { createEmptyCompressionState } from "../compression";
import type { SessionFile } from "../store/helpers";
import { LoopJobCoordinator } from "./coordinator";
import { LoopJobQueue } from "./job-queue";
import { LoopRunner, type LoopRunnerWorktreeManager } from "./runner";
import { LoopScheduler, type LoopSchedulerRunInput, type LoopSchedulerTimer } from "./scheduler";
import { LoopStateManager, type LoopConfig, type LoopWorktreeArtifact } from "./state";
import { createLoopSchedulerRequiredDependencies } from "./test-utils";
import { LoopWorktreeManagerError, type LoopWorktreeInspection } from "./worktree-manager";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-blocked-run");
const COMPLETED_EXECUTION: SessionExecutionRecord = { id: "run-1", startedAt: 100, status: "completed", endedAt: 150, durationMs: 50 };

const sessionLoopConfig: LoopConfig = {
  templateId: "watch_report",
  title: "Blocked loop",
  schedule: { kind: "manual" },
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 3, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
  taskPrompt: "Run safely unless user input is needed.",
  useWorktree: true,
};

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("blocked queued loop runs", () => {
  test("pending hitl Goal confirmation request maps to needs_user", async () => {
    const fixture = await createRunnerFixture({ events: [hitlRequestEvent("hitl-1")] });
    const loop = await fixture.stateManager.create("project-a", { ...sessionLoopConfig, useWorktree: false });

    const result = await fixture.runner.createSchedulerRunner()({
      ...checkpointCallbacks(),
      loop,
      trigger: "manual",
      runId: "hitl-run",
      startedAt: 1_000,
      job: testJob(loop.loopId),
    });
    if (result === undefined) throw new Error("Expected scheduler runner result");

    expect(result).toMatchObject({ status: "needs_user", blockedReason: "needs_user", sessionId: "session-1", blockedByHitlIds: ["hitl-1"] });
    expect(result.summary).toContain("blocked waiting for user input");
  });

  test("loop-started Session ask_user hitl maps to needs_user with child blockedByHitlIds", async () => {
    const fixture = await createRunnerFixture({ blockedByHitlIds: ["session-hitl-1"] });
    const loop = await fixture.stateManager.create("project-a", { ...sessionLoopConfig, useWorktree: false });

    const result = await fixture.runner.createSchedulerRunner()({
      checkpointBaseSha: async () => {},
      checkpointWorktree: async () => {},
      checkpointSessionAttempt: async () => {},
      loop,
      trigger: "manual",
      runId: "session-hitl-run",
      startedAt: 1_000,
      job: testJob(loop.loopId),
    });
    if (result === undefined) throw new Error("Expected scheduler runner result");

    expect(result).toMatchObject({
      status: "needs_user",
      blockedReason: "needs_user",
      blockedByHitlIds: ["session-hitl-1"],
      attentionStatus: "waiting_for_human",
      sessionId: "session-1",
    });
  });

  test("dirty canonical blocks before worktree creation completes and before session execution", async () => {
    const worktreeManager = new DirtyCanonicalWorktreeManager();
    const fixture = await createRunnerFixture({ worktreeManager });
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);

    const result = await fixture.runner.createSchedulerRunner()({
      checkpointBaseSha: async () => {},
      checkpointWorktree: async () => {},
      checkpointSessionAttempt: async () => {},
      loop,
      trigger: "manual",
      runId: "dirty-run",
      startedAt: 1_000,
      job: testJob(loop.loopId, { baseSha: "a".repeat(40) }),
    });
    if (result === undefined) throw new Error("Expected scheduler runner result");

    expect(result).toMatchObject({ status: "skipped", blockedReason: "dirty-canonical" });
    expect(worktreeManager.createMock).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.createSessionMock).not.toHaveBeenCalled();
    expect(fixture.runtime.startSessionExecutionMock).not.toHaveBeenCalled();
  });

  test("scheduler writes canonical run-log and blocked job metadata from worktree result", async () => {
    const workspaceRoot = join(TMP_DIR, "canonical-scheduler");
    await mkdir(workspaceRoot, { recursive: true });
    const stateManager = new LoopStateManager(workspaceRoot);
    const loop = await stateManager.create("project-a", sessionLoopConfig);
    const clock = new FakeClock(1_000);
    const jobQueue = new LoopJobQueue({ workspaceRoot, clock });
    const coordinator = new LoopJobCoordinator({ queue: jobQueue, clock, leaseTtlMs: 60_000 });
    const observedArtifacts: LoopWorktreeArtifact[] = [{ path: "evidence/report.md", status: "created" }];
    const hitlId = "hitl-worktree-blocked";
    const runnerMock = mock(async (input: LoopSchedulerRunInput) => ({
      status: "needs_user" as const,
      sessionId: "session-worktree",
      blockedReason: "needs_user",
      blockedByHitlIds: [hitlId],
      attentionStatus: "waiting_for_human" as const,
      worktreePath: "/tmp/archcode-loop-worktree",
      worktreeBranchName: "archcode/loop/test/blocked",
      baseSha: "a".repeat(40),
      resolvedHeadSha: "b".repeat(40),
      resumeCheckpoint: {
        version: 1 as const,
        hitlId,
        loopId: input.loop.loopId,
        runId: input.runId,
        jobId: input.job.jobId,
        trigger: input.trigger,
        subjectKey: input.job.subjectKey,
        worktreePath: "/tmp/archcode-loop-worktree",
        worktreeBranchName: "archcode/loop/test/blocked",
        baseSha: "a".repeat(40),
        resolvedHeadSha: "b".repeat(40),
        intendedContinuation: "resume_run" as const,
      },
      cleanupState: "preserved" as const,
      observedArtifacts,
      summary: "waiting for user",
    }));
    const scheduler = new LoopScheduler({
      ...createLoopSchedulerRequiredDependencies({ workspaceRoot, stateManager, clock }),
      stateManager,
      jobQueue,
      coordinator,
      clock,
      timer: new FakeTimer(),
      runner: runnerMock,
      cleanupJob: async () => undefined,
      readSessionAttempt: async () => ({}),
    });

    const report = await scheduler.runManual(loop.loopId);

    expect(runnerMock).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      status: "needs_user",
      blockedReason: "needs_user",
      worktreePath: "/tmp/archcode-loop-worktree",
      baseSha: "a".repeat(40),
      resolvedHeadSha: "b".repeat(40),
      cleanupState: "preserved",
      observedArtifacts,
    });
    const log = await stateManager.readRunLog(loop.loopId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ loopId: loop.loopId, worktreePath: "/tmp/archcode-loop-worktree", blockedReason: "needs_user" });
    expect(await Bun.file(join(workspaceRoot, ".archcode", "loops", loop.loopId, "run-log.jsonl")).exists()).toBe(true);
    expect(await Bun.file(join("/tmp/archcode-loop-worktree", ".archcode", "loops", loop.loopId, "run-log.jsonl")).exists()).toBe(false);
    const jobs = await jobQueue.list();
    expect(jobs[0]).toMatchObject({
      status: "needs_user",
      blockedReason: "needs_user",
      worktreePath: "/tmp/archcode-loop-worktree",
      baseSha: "a".repeat(40),
      resolvedHeadSha: "b".repeat(40),
      cleanupState: "preserved",
      observedArtifacts,
    });
  });
});

async function createRunnerFixture(options: {
  events?: SessionEventEnvelope[];
  blockedByHitlIds?: string[];
  worktreeManager?: LoopRunnerWorktreeManager;
} = {}): Promise<{
  stateManager: LoopStateManager;
  runtime: FakeLoopRuntime;
  runner: LoopRunner;
  workspaceRoot: string;
}> {
  const workspaceRoot = join(TMP_DIR, `workspace-${crypto.randomUUID()}`);
  await mkdir(workspaceRoot, { recursive: true });
  const stateManager = new LoopStateManager(workspaceRoot);
  const runtime = new FakeLoopRuntime(options.events ?? [], options.blockedByHitlIds ?? []);
  const runner = new LoopRunner({
    stateManager,
    runtime,
    workspaceRoot,
    projectSlug: "project-a",
    now: () => 1_000,
    worktreeManager: options.worktreeManager ?? new DirtyCanonicalWorktreeManager(),
  });
  return { stateManager, runtime, runner, workspaceRoot };
}

class FakeLoopRuntime {
  #nextSession = 1;
  readonly #sessions = new Map<string, SessionFile>();
  readonly createSessionMock = mock(async (_workspaceRoot: string, options?: { loopId?: string; sessionRole?: "main"; title?: string }): Promise<SessionFile> => {
    const sessionId = `session-${this.#nextSession++}`;
    const session = makeSession(sessionId, this.events, this.blockedByHitlIds, options);
    this.#sessions.set(sessionId, session);
    return session;
  });
  readonly startSessionExecutionMock = mock((input: StartSessionExecutionInput): ActiveSessionExecution => ({
    sessionId: input.sessionId,
    rootSessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
    agentName: input.agentName ?? "orchestrator",
    origin: "user_message",
    abortController: new AbortController(),
    promise: Promise.resolve(),
    executionToken: Symbol(`test:${input.sessionId}`),
    startedAt: Date.now(),
  }));
  readonly getSessionFileMock = mock(async (_workspaceRoot: string, sessionId: string): Promise<SessionFile> => {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new Error(`Missing fake session ${sessionId}`);
    return session;
  });

  constructor(
    private readonly events: SessionEventEnvelope[],
    private readonly blockedByHitlIds: string[],
  ) {}

  async createSession(workspaceRoot: string, options?: { loopId?: string; sessionRole?: "main"; title?: string }): Promise<SessionFile> {
    return await this.createSessionMock(workspaceRoot, options);
  }

  async getSessionFile(workspaceRoot: string, sessionId: string): Promise<SessionFile> {
    return await this.getSessionFileMock(workspaceRoot, sessionId);
  }

  startSessionExecution(input: StartSessionExecutionInput): ActiveSessionExecution {
    return this.startSessionExecutionMock(input);
  }

  releaseSessionAgent(): void {}

  async migrateSessionCwdReferencesForRemoval<T extends SessionCwdRemovalResult>(
    _input: SessionCwdReferenceMigrationInput,
    operation: (lifecycle: SessionCwdRemovalLifecycle) => Promise<T>,
  ): Promise<T> {
    return await operation({
      beforeRemove: async () => undefined,
      onRemoveFailureBeforeDetach: async () => undefined,
      onRemoveDetached: async () => undefined,
    });
  }
}

class DirtyCanonicalWorktreeManager implements LoopRunnerWorktreeManager {
  readonly createMock = mock(async (_input: Parameters<LoopRunnerWorktreeManager["create"]>[0]): Promise<never> => {
    throw new LoopWorktreeManagerError("CANONICAL_DIRTY", "Canonical checkout must be clean before creating a loop worktree", {
      entries: [{ path: "dirty.txt", index: "?", worktree: "?", raw: "?? dirty.txt" }],
    });
  });

  async create(input: Parameters<LoopRunnerWorktreeManager["create"]>[0]): ReturnType<LoopRunnerWorktreeManager["create"]> {
    return await this.createMock(input);
  }

  async reuse(_input: Parameters<LoopRunnerWorktreeManager["reuse"]>[0]): ReturnType<LoopRunnerWorktreeManager["reuse"]> {
    throw new Error("dirty canonical should block before reuse");
  }

  async inspect(_input: Parameters<LoopRunnerWorktreeManager["inspect"]>[0]): Promise<LoopWorktreeInspection> {
    throw new Error("dirty canonical should block before inspect");
  }

  async cleanup(_input: Parameters<LoopRunnerWorktreeManager["cleanup"]>[0]): ReturnType<LoopRunnerWorktreeManager["cleanup"]> {
    throw new Error("dirty canonical should block before cleanup");
  }
}

class FakeClock {
  constructor(private value: number) {}
  now(): number { return this.value; }
}

class FakeTimer implements LoopSchedulerTimer {
  schedule(_delayMs: number, callback: () => void | Promise<void>): { id: ReturnType<typeof setTimeout> } {
    const timer = setTimeout(() => { void callback(); }, 0);
    return { id: timer };
  }
  cancel(handle: { id?: unknown }): void {
    if (handle.id !== undefined) clearTimeout(handle.id as ReturnType<typeof setTimeout>);
  }
}

function makeSession(
  sessionId: string,
  events: SessionEventEnvelope[],
  blockedByHitlIds: string[],
  options?: { loopId?: string; sessionRole?: "main"; title?: string },
): SessionFile {
  const now = Date.now();
  return {
    schemaVersion: 1,
    sessionId,
    createdAt: now,
    updatedAt: now,
    cwd: TMP_DIR,
    agentName: "orchestrator",
    modelInfo: null,
    title: options?.title ?? null,
    messages: [],
    steps: [],
    stats: createEmptySessionStats(),
    executions: [COMPLETED_EXECUTION],
    compression: createEmptyCompressionState(),
    events,
    todos: [],
    reminders: [],
    childSessionLinks: [],
    rootSessionId: sessionId,
    ...(blockedByHitlIds.length === 0 ? {} : { blockedByHitlIds }),
    ...(options?.loopId === undefined ? {} : { loopId: options.loopId }),
    ...(options?.sessionRole === undefined ? {} : { sessionRole: options.sessionRole }),
  };
}

function testJob(loopId: string, overrides: Partial<NonNullable<LoopSchedulerRunInput["job"]>> = {}): NonNullable<LoopSchedulerRunInput["job"]> {
  return {
    jobId: "job-blocked-123",
    triggerKind: "manual",
    subjectKey: `manual:${loopId}`,
    dedupeKey: `loop:${loopId}:manual`,
    ...overrides,
  };
}

function checkpointCallbacks(): Pick<LoopSchedulerRunInput, "checkpointBaseSha" | "checkpointWorktree" | "checkpointSessionAttempt"> {
  return {
    checkpointBaseSha: async () => {},
    checkpointWorktree: async () => {},
    checkpointSessionAttempt: async () => {},
  };
}

function hitlRequestEvent(hitlId: string): SessionEventEnvelope {
  return envelope(1, {
    type: "hitl.request",
    request: {
      hitlId,
      owner: { projectSlug: "project-a", ownerType: "session", ownerId: "session-1" },
      sessionRootId: "session-1",
      blockingKey: `session:session-1:approval:${hitlId}`,
      source: { type: "ask_user", sessionId: "session-1" },
      status: "pending",
      displayPayload: { title: "Approve goal?", redacted: true },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  });
}

function envelope(id: number, payload: SessionEventEnvelope["payload"]): SessionEventEnvelope {
  return { id, createdAt: Date.now(), kind: payload.type, payload };
}
