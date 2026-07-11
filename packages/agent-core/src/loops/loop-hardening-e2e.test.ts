import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats, type SessionExecutionRecord } from "@archcode/protocol";

import type { ActiveSessionExecution, SessionCwdReferenceMigrationInput, SessionCwdRemovalLifecycle, SessionCwdRemovalResult, StartSessionExecutionInput } from "../execution";
import { createEmptyCompressionState } from "../compression";
import type { GitHubCiPollingConnectorApi, GitHubPullRequest, GitHubReadCiFailuresForRefOptions, GitHubReadCiFailuresForRefResult, GitHubResponse } from "../integrations/github";
import type { SessionFile } from "../store/helpers";
import { CollisionLedger } from "./collision-ledger";
import { LoopCleanupService } from "./cleanup";
import { LoopJobCoordinator } from "./coordinator";
import { LoopJobQueue } from "./job-queue";
import { LoopKillStateManager } from "./kill-state";
import { LoopRunner, type LoopRunnerWorktreeManager } from "./runner";
import { LoopScheduler, type LoopSchedulerTimer, type LoopSchedulerTimerHandle } from "./scheduler";
import { LoopPollStateManager } from "./poll-state";
import { LoopStateManager, type LoopConfig } from "./state";
import { createLoopSchedulerRequiredDependencies, FakeClock } from "./test-utils";
import { LoopTriggerPoller } from "./triggers";
import type { LoopWorktreeCreateResult, LoopWorktreeInspection } from "./worktree-manager";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-hardening-e2e");
const HEAD_ONE = "1".repeat(40);
const HEAD_TWO = "2".repeat(40);

const loopHardeningConfig: LoopConfig = {
  templateId: "maintain_fix",
  title: null,
  schedule: { kind: "manual" },
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 4, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
  taskPrompt: "Review the observed PR and write a concise artifact summary.",
  triggers: [{ kind: "on_pr", cadenceMs: 60_000, baseBranch: "main" }],
  useWorktree: true,
  cleanupPolicy: { enabled: true, action: "mark", deleteUnchangedWorktrees: true, preserveChangedArtifacts: true },
};

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("Loop hardening e2e", () => {
  test("polls PR triggers, serializes same-PR jobs, runs mocked sessions in worktrees, and records cleanup artifacts", async () => {
    const clock = new FakeClock(Date.UTC(2026, 6, 6, 10, 0, 0));
    const stateManager = new LoopStateManager(TMP_DIR);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const coordinator = new LoopJobCoordinator({ queue, clock, config: { maxConcurrent: 2 }, leaseTtlMs: 60_000 });
    const github = new FakeGitHub(HEAD_ONE);
    const poller = new LoopTriggerPoller({
      workspaceRoot: TMP_DIR,
      stateManager,
      queue,
      pollState: new LoopPollStateManager({ workspaceRoot: TMP_DIR, clock }),
      github: github as unknown as GitHubCiPollingConnectorApi,
      repository: { owner: "test-owner", repo: "test-repo", defaultBranch: "main" },
      clock,
    });
    const runtime = new FakeLoopRuntime();
    const worktreeManager = new FakeWorktreeManager(TMP_DIR);
    const collisionLedger = new CollisionLedger({ stateManager, workspaceRoot: TMP_DIR, clock, leaseTtlMs: 60_000 });
    const runner = new LoopRunner({
      stateManager,
      runtime,
      workspaceRoot: TMP_DIR,
      projectSlug: "project-a",
      now: () => clock.now(),
      collisionLedger,
      worktreeManager,
    });
    const cleanupService = new LoopCleanupService({
      stateManager,
      jobQueue: queue,
      collisionLedger,
      worktreeManager,
      workspaceRoot: TMP_DIR,
      clock,
      migrateSessionCwdReferencesForRemoval: (input, operation) => (
        runtime.migrateSessionCwdReferencesForRemoval(input, operation)
      ),
    });
    const scheduler = new LoopScheduler({
      ...createLoopSchedulerRequiredDependencies({ workspaceRoot: TMP_DIR, stateManager, clock }),
      stateManager,
      runner: runner.createSchedulerRunner(),
      clock,
      timer: new NoopTimer(),
      jobQueue: queue,
      coordinator,
      collisionLedger,
      killStateManager: new LoopKillStateManager(TMP_DIR, { clock }),
      triggerPoller: poller,
      cleanupJob: (jobId) => cleanupService.cleanupJob(jobId),
      readSessionAttempt: async () => ({}),
    });
    const loop = await stateManager.create("project-a", loopHardeningConfig);

    const firstPoll = await poller.pollLoop(loop.loopId);
    expect(firstPoll.enqueued).toHaveLength(1);
    expect(firstPoll.health[0]).toMatchObject({ triggerKind: "on_pr", status: "healthy", cadenceMs: 60_000 });
    expect((await queue.list())[0]).toMatchObject({
      triggerKind: "on_pr",
      subjectKey: `pr:test-owner/test-repo#42:${HEAD_ONE}`,
      collisionKey: "github:test-owner/test-repo:pr:42",
      baseSha: HEAD_ONE,
    });

    const schedulerStarted = scheduler.start("project-a");
    await waitFor(() => runtime.startSessionExecutionMock.mock.calls.length === 1);
    expect(worktreeManager.createMock.mock.calls[0]?.[0]).toMatchObject({
      loopSlug: `loop-${loop.loopId.slice(0, 8)}`,
      subjectSlug: `pr:test-owner/test-repo#42:${HEAD_ONE}`,
      baseSha: HEAD_ONE,
      jobClass: "remote",
    });

    github.setHeadSha(HEAD_TWO);
    clock.set(clock.now() + 1_000);
    const secondPoll = await poller.pollLoop(loop.loopId);
    expect(secondPoll.enqueued).toHaveLength(1);

    const queuedWhileFirstRuns = await queue.list();
    expect(queuedWhileFirstRuns.map((job) => job.status)).toEqual(["running", "pending"]);
    expect(queuedWhileFirstRuns.map((job) => job.collisionKey)).toEqual([
      "github:test-owner/test-repo:pr:42",
      "github:test-owner/test-repo:pr:42",
    ]);
    expect(runtime.startSessionExecutionMock).toHaveBeenCalledTimes(1);

    runtime.resolveExecution();
    await schedulerStarted;

    const jobs = await queue.list();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.status)).toEqual(["succeeded", "succeeded"]);
    expect(jobs[0]).toMatchObject({ cleanupState: "cleaned", resolvedHeadSha: `${"b".repeat(39)}1` });
    expect(jobs[1]).toMatchObject({ cleanupState: "preserved", resolvedHeadSha: `${"b".repeat(39)}2` });
    expect(jobs[1]?.observedArtifacts).toContainEqual({ path: "evidence/report.md", status: "created", sizeBytes: 128, sha: "artifact-sha-2" });

    const reports = await stateManager.readRunLog(loop.loopId);
    expect(reports).toHaveLength(2);
    expect(reports.map((report) => report.trigger)).toEqual(["on_pr", "on_pr"]);
    const cleanedReport = reports.find((report) => report.baseSha === HEAD_ONE);
    const preservedReport = reports.find((report) => report.baseSha === HEAD_TWO);
    expect(cleanedReport).toMatchObject({
      status: "succeeded",
      cleanupState: "cleaned",
      worktreePath: join(TMP_DIR, "worktrees", "worktree-1"),
      baseSha: HEAD_ONE,
    });
    expect(cleanedReport?.observedArtifacts).toContainEqual({ path: "cleanup:cleaned", status: "observed" });
    expect(preservedReport).toMatchObject({
      status: "succeeded",
      cleanupState: "preserved",
      worktreePath: join(TMP_DIR, "worktrees", "worktree-2"),
      baseSha: HEAD_TWO,
    });
    expect(preservedReport?.observedArtifacts).toContainEqual({ path: "cleanup:preserved", status: "observed" });

    const latest = await stateManager.read(loop.loopId);
    expect(latest.lastRun).toMatchObject({ runId: preservedReport?.runId, jobId: jobs[1]?.jobId, cleanupState: "preserved" });
    expect(latest.currentRun).toBeUndefined();
    expect(latest.triggerHealth?.[0]).toMatchObject({ triggerKind: "on_pr", status: "healthy", cadenceMs: 60_000 });
    expect(runtime.createSessionMock.mock.calls.map(([projectRoot, options]) => [projectRoot, options?.cwd])).toEqual([
      [TMP_DIR, join(TMP_DIR, "worktrees", "worktree-1")],
      [TMP_DIR, join(TMP_DIR, "worktrees", "worktree-2")],
    ]);
    expect(runtime.releaseSessionAgentMock.mock.calls).toEqual([
      [TMP_DIR, "session-1"],
      [TMP_DIR, "session-2"],
    ]);
    expect(github.listOpenPullRequestsMock).toHaveBeenCalledTimes(4);
  });
});

class NoopTimer implements LoopSchedulerTimer {
  schedule(_delayMs: number, _callback: () => void | Promise<void>): LoopSchedulerTimerHandle {
    return { id: crypto.randomUUID() };
  }

  cancel(_handle: LoopSchedulerTimerHandle): void {}
}

class FakeGitHub {
  readonly listOpenPullRequestsMock = mock(async (_owner: string, _repo: string, filters?: unknown): Promise<GitHubResponse<readonly GitHubPullRequest[]>> => {
    this.filters.push(filters);
    return { data: [makePullRequest(this.headSha)], status: 200 };
  });
  readonly filters: unknown[] = [];

  constructor(private headSha: string) {}

  setHeadSha(headSha: string): void {
    this.headSha = headSha;
  }

  async listOpenPullRequests(owner: string, repo: string, filters?: unknown): Promise<GitHubResponse<readonly GitHubPullRequest[]>> {
    return await this.listOpenPullRequestsMock(owner, repo, filters);
  }

  async readCiFailuresForRef(_owner: string, _repo: string, _ref: string, options?: GitHubReadCiFailuresForRefOptions): Promise<GitHubReadCiFailuresForRefResult> {
    return { failures: [], health: { triggerKind: "on_ci_fail", status: "healthy", lastPollAt: options?.lastPollAt ?? 0 }, shouldEnqueue: false };
  }
}

class FakeLoopRuntime {
  #nextSession = 1;
  #resolveExecution: () => void = () => {};
  #executionPromise = new Promise<void>((resolve) => {
    this.#resolveExecution = resolve;
  });
  readonly #sessions = new Map<string, SessionFile>();
  readonly releaseSessionAgentMock = mock((_projectRoot: string, _sessionId: string): void => {});
  readonly createSessionMock = mock(async (_projectRoot: string, options?: { cwd?: string; loopId?: string; sessionRole?: "main"; title?: string }): Promise<SessionFile> => {
    const sessionId = `session-${this.#nextSession++}`;
    const session = makeSession(sessionId, options);
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
    promise: this.#executionPromise,
    executionToken: Symbol(`loop-hardening:${input.sessionId}`),
    startedAt: Date.now(),
  }));
  readonly getSessionFileMock = mock(async (_workspaceRoot: string, sessionId: string): Promise<SessionFile> => {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new Error(`Missing fake session ${sessionId}`);
    return session;
  });

  resolveExecution(): void {
    this.#resolveExecution();
  }

  async createSession(projectRoot: string, options?: { cwd?: string; loopId?: string; sessionRole?: "main"; title?: string }): Promise<SessionFile> {
    return await this.createSessionMock(projectRoot, options);
  }

  async getSessionFile(workspaceRoot: string, sessionId: string): Promise<SessionFile> {
    return await this.getSessionFileMock(workspaceRoot, sessionId);
  }

  startSessionExecution(input: StartSessionExecutionInput): ActiveSessionExecution {
    return this.startSessionExecutionMock(input);
  }

  releaseSessionAgent(projectRoot: string, sessionId: string): void {
    this.releaseSessionAgentMock(projectRoot, sessionId);
  }

  async migrateSessionCwdReferencesForRemoval<T extends SessionCwdRemovalResult>(
    input: SessionCwdReferenceMigrationInput,
    operation: (lifecycle: SessionCwdRemovalLifecycle) => Promise<T>,
  ): Promise<T> {
    return await operation({
      beforeRemove: async () => {
        for (const [sessionId, session] of this.#sessions) {
          if (session.cwd === input.fromCwd) this.#sessions.set(sessionId, { ...session, cwd: input.toCwd });
        }
      },
      onRemoveFailureBeforeDetach: async () => {
        for (const [sessionId, session] of this.#sessions) {
          if (session.cwd === input.toCwd) this.#sessions.set(sessionId, { ...session, cwd: input.fromCwd });
        }
      },
      onRemoveDetached: async () => undefined,
    });
  }
}

class FakeWorktreeManager implements LoopRunnerWorktreeManager {
  #createCount = 0;
  readonly createMock = mock(async (input: { loopSlug: string; subjectSlug: string; jobId: string; baseSha: string; jobClass?: "local" | "remote" }): Promise<LoopWorktreeCreateResult> => {
    this.#createCount += 1;
    const worktreePath = join(this.root, "worktrees", `worktree-${this.#createCount}`);
    await mkdir(worktreePath, { recursive: true });
    return {
      canonicalRoot: this.root,
      managedRoot: join(this.root, "worktrees"),
      worktreePath,
      worktreeName: `worktree-${this.#createCount}`,
      branchName: `archcode/loop/hardening/job-${this.#createCount}`,
      baseSha: input.baseSha,
      resolvedHeadSha: input.baseSha,
      canonicalStatus: { dirty: false, entries: [] },
    };
  });
  readonly inspectMock = mock(async (input: { worktreePath: string; branchName: string; baseSha: string; evidencePaths?: readonly string[] }): Promise<LoopWorktreeInspection> => {
    const index = input.worktreePath.endsWith("worktree-1") ? 1 : 2;
    const hasChanges = index === 2;
    return {
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      baseSha: input.baseSha,
      headSha: `${"b".repeat(39)}${index}`,
      status: { dirty: hasChanges, entries: hasChanges ? [{ path: "evidence/report.md", index: "?", worktree: "?", raw: "?? evidence/report.md" }] : [] },
      untrackedFiles: hasChanges ? ["evidence/report.md"] : [],
      localCommitsAhead: 0,
      changedRefs: [],
      diffStats: { committed: "", workingTree: hasChanges ? " evidence/report.md | 1 +" : "" },
      evidenceArtifacts: hasChanges ? [{ path: "evidence/report.md", status: "created", sizeBytes: 128, sha: `artifact-sha-${index}` }] : [],
      hasChanges,
    };
  });
  readonly cleanupMock = mock(async (input: Parameters<LoopRunnerWorktreeManager["cleanup"]>[0]) => {
    if (!input.inspection.hasChanges) {
      await input.beforeRemove?.();
      await input.onRemoveDetached?.();
    }
    return {
      cleanupState: input.inspection.hasChanges ? "preserved" as const : "cleaned" as const,
      removed: !input.inspection.hasChanges,
      reviewRequired: input.inspection.hasChanges,
      reason: input.inspection.hasChanges ? "worktree contains changes" : "worktree has no changes",
      worktreePath: input.inspection.worktreePath,
    };
  });

  constructor(private readonly root: string) {}

  async create(input: Parameters<FakeWorktreeManager["createMock"]>[0]): Promise<LoopWorktreeCreateResult> {
    return await this.createMock(input);
  }

  async reuse(input: Parameters<LoopRunnerWorktreeManager["reuse"]>[0]): Promise<LoopWorktreeCreateResult> {
    const index = input.worktreePath.endsWith("worktree-1") ? 1 : 2;
    return {
      canonicalRoot: this.root,
      managedRoot: join(this.root, "worktrees"),
      worktreePath: input.worktreePath,
      worktreeName: `worktree-${index}`,
      branchName: `archcode/loop/hardening/job-${index}`,
      baseSha: input.baseSha,
      resolvedHeadSha: input.baseSha,
      canonicalStatus: { dirty: false, entries: [] },
    };
  }

  async inspect(input: Parameters<FakeWorktreeManager["inspectMock"]>[0]): Promise<LoopWorktreeInspection> {
    return await this.inspectMock(input);
  }

  async cleanup(input: Parameters<FakeWorktreeManager["cleanupMock"]>[0]): ReturnType<FakeWorktreeManager["cleanupMock"]> {
    return await this.cleanupMock(input);
  }
}

function makePullRequest(headSha: string): GitHubPullRequest {
  return {
    number: 42,
    state: "open",
    title: "Harden loop execution path",
    head: { ref: "feature/loop-hardening", sha: headSha },
    base: { ref: "main" },
    updated_at: `2026-07-06T10:00:${headSha === HEAD_ONE ? "01" : "02"}Z`,
  };
}

function makeSession(sessionId: string, options?: { cwd?: string; loopId?: string; sessionRole?: "main"; title?: string }): SessionFile {
  const executions: SessionExecutionRecord[] = [{ id: `${sessionId}-execution`, startedAt: 100, status: "completed", endedAt: 150, durationMs: 50 }];
  const now = Date.now();
  return {
    schemaVersion: 1,
    sessionId,
    createdAt: now,
    updatedAt: now,
    cwd: options?.cwd ?? TMP_DIR,
    agentName: "orchestrator",
    modelInfo: null,
    title: options?.title ?? null,
    messages: [],
    steps: [],
    stats: createEmptySessionStats(),
    executions,
    compression: createEmptyCompressionState(),
    todos: [],
    reminders: [],
    childSessionLinks: [],
    rootSessionId: sessionId,
    ...(options?.loopId === undefined ? {} : { loopId: options.loopId }),
    ...(options?.sessionRole === undefined ? {} : { sessionRole: options.sessionRole }),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for predicate");
}
