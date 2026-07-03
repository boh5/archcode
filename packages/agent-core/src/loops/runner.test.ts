import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats, type SessionExecutionRecord } from "@archcode/protocol";

import type { ActiveSessionExecution, StartSessionExecutionInput } from "../execution";
import type { SessionFile } from "../store/helpers";
import { LoopActiveConflictError, LoopRunner } from "./runner";
import { LoopStateManager, type LoopConfig } from "./state";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-runner");
const WORKSPACE_ROOT = join(TMP_DIR, "workspace");

const sessionLoopConfig: LoopConfig = {
  title: "Daily triage",
  description: "Review repository health",
  schedule: { kind: "manual" },
  runKind: "session",
  mode: "act",
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 7 },
  taskPrompt: "Inspect status and summarize risks.",
  instructions: "Keep the report concise.",
};

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(WORKSPACE_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("session loop runner", () => {
  test("creates a linked main session and records a succeeded run report", async () => {
    const fixture = await createFixture();
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);

    const report = await fixture.runner.runSessionLoop(loop, "manual");

    expect(report.status).toBe("succeeded");
    expect(report.sessionId).toBe("session-1");
    expect(report.summary).toContain("Session session-1 completed");
    expect(report.startedAt).toBe(1_000);
    expect(report.endedAt).toBe(1_000);
    expect(fixture.runtime.createSessionMock).toHaveBeenCalledWith(WORKSPACE_ROOT, {
      loopId: loop.loopId,
      sessionRole: "main",
      title: "Loop: Daily triage",
    });
    expect(fixture.runtime.startSessionExecutionMock).toHaveBeenCalledWith(expect.objectContaining({
      slug: "project-a",
      workspaceRoot: WORKSPACE_ROOT,
      sessionId: "session-1",
      maxSteps: 7,
      origin: {
        kind: "loop",
        loopId: loop.loopId,
        trigger: "manual",
        mode: "act",
        approvalPolicy: "interactive",
      },
    } satisfies Partial<StartSessionExecutionInput>));
    const executionInput = fixture.runtime.startSessionExecutionMock.mock.calls[0]?.[0];
    expect(executionInput?.userMessage).toContain("Task prompt:\nInspect status and summarize risks.");
    expect(executionInput?.userMessage).toContain("Instructions:\nKeep the report concise.");

    const state = await fixture.stateManager.read(loop.loopId);
    expect(state.currentRun).toBeUndefined();
    expect(state.lastRun).toMatchObject({ status: "succeeded", sessionId: "session-1" });
    expect(state.runCount).toBe(1);
    const log = await fixture.stateManager.readRunLog(loop.loopId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: "succeeded", sessionId: "session-1" });
  });

  test("records failed report when session execution rejects", async () => {
    const deferred = createDeferred<void>();
    const fixture = await createFixture({ executionPromise: deferred.promise });
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);

    const run = fixture.runner.runSessionLoop(loop, "manual");
    await waitFor(() => fixture.runtime.startSessionExecutionMock.mock.calls.length === 1);
    deferred.reject(new Error("boom"));
    const report = await run;

    expect(report.status).toBe("failed");
    expect(report.error).toBe("boom");
    expect(report.sessionId).toBe("session-1");
    expect((await fixture.stateManager.read(loop.loopId)).lastRun).toMatchObject({ status: "failed", sessionId: "session-1", error: "boom" });
    expect(await fixture.stateManager.readRunLog(loop.loopId, 1)).toEqual([expect.objectContaining({ status: "failed", sessionId: "session-1", error: "boom" })]);
  });

  test("records failed report when execution promise resolves but session status is failed", async () => {
    const fixture = await createFixture({
      sessionExecutions: [{ id: "run-1", startedAt: 100, status: "failed", endedAt: 150, durationMs: 50, error: "agent failed" }],
    });
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);

    const report = await fixture.runner.runSessionLoop(loop, "manual");

    expect(report.status).toBe("failed");
    expect(report.sessionId).toBe("session-1");
    expect(report.error).toBe("agent failed");
    expect((await fixture.stateManager.read(loop.loopId)).lastRun).toMatchObject({ status: "failed", sessionId: "session-1", error: "agent failed" });
  });

  test("exposes active conflict without creating a second session for overlapping manual trigger", async () => {
    const deferred = createDeferred<void>();
    const fixture = await createFixture({ executionPromise: deferred.promise });
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);

    const first = fixture.runner.runSessionLoop(loop, "manual");
    try {
      await waitFor(() => fixture.runtime.startSessionExecutionMock.mock.calls.length === 1);

      await expect(fixture.runner.runSessionLoop(loop, "manual")).rejects.toThrow(LoopActiveConflictError);
      expect(fixture.runtime.createSessionMock).toHaveBeenCalledTimes(1);
      expect(fixture.runtime.startSessionExecutionMock).toHaveBeenCalledTimes(1);
    } finally {
      deferred.resolve();
    }

    expect((await first).status).toBe("succeeded");
  });

  test("scheduler-compatible callback starts a session and returns result without writing reports itself", async () => {
    const fixture = await createFixture();
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);

    const result = await fixture.runner.createSchedulerRunner()({
      loop,
      trigger: "interval",
      runId: "run-from-scheduler",
      startedAt: 2_000,
    });

    expect(result).toMatchObject({ status: "succeeded", sessionId: "session-1" });
    expect((await fixture.stateManager.readRunLog(loop.loopId))).toEqual([]);
    expect(fixture.runtime.startSessionExecutionMock.mock.calls[0]?.[0].origin).toMatchObject({
      kind: "loop",
      loopId: loop.loopId,
      trigger: "interval",
    });
  });
});

async function createFixture(options: { executionPromise?: Promise<void>; sessionExecutions?: SessionExecutionRecord[] } = {}): Promise<{
  stateManager: LoopStateManager;
  runtime: FakeLoopRuntime;
  runner: LoopRunner;
}> {
  const stateManager = new LoopStateManager(WORKSPACE_ROOT);
  const runtime = new FakeLoopRuntime(options.executionPromise ?? Promise.resolve(), options.sessionExecutions);
  const runner = new LoopRunner({
    stateManager,
    runtime,
    workspaceRoot: WORKSPACE_ROOT,
    projectSlug: "project-a",
    now: () => 1_000,
  });
  return { stateManager, runtime, runner };
}

class FakeLoopRuntime {
  #nextSession = 1;
  readonly #sessions = new Map<string, SessionFile>();
  readonly createSessionMock = mock(async (_workspaceRoot: string, options?: { loopId?: string; sessionRole?: "main"; title?: string }): Promise<SessionFile> => {
    const sessionId = `session-${this.#nextSession++}`;
    const session: SessionFile = {
      sessionId,
      createdAt: Date.now(),
      agentName: "orchestrator",
      title: options?.title ?? null,
      messages: [],
      steps: [],
      stats: createEmptySessionStats(),
      executions: this.sessionExecutions,
      todos: [],
      pendingInteractions: [],
      reminders: [],
      childSessionLinks: [],
      rootSessionId: sessionId,
      ...(options?.loopId === undefined ? {} : { loopId: options.loopId }),
      ...(options?.sessionRole === undefined ? {} : { sessionRole: options.sessionRole }),
    };
    this.#sessions.set(sessionId, session);
    return session;
  });
  readonly startSessionExecutionMock = mock((input: StartSessionExecutionInput): ActiveSessionExecution => ({
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
    agentName: input.agentName ?? "orchestrator",
    origin: "user_message",
    abortController: new AbortController(),
    promise: this.executionPromise,
    executionToken: Symbol(`test:${input.sessionId}`),
    startedAt: Date.now(),
  }));

  constructor(
    private readonly executionPromise: Promise<void>,
    private readonly sessionExecutions: SessionExecutionRecord[] = [{ id: "run-1", startedAt: 100, status: "completed", endedAt: 150, durationMs: 50 }],
  ) {}

  async createSession(workspaceRoot: string, options?: { loopId?: string; sessionRole?: "main"; title?: string }): Promise<SessionFile> {
    return await this.createSessionMock(workspaceRoot, options);
  }

  async getSessionFile(_workspaceRoot: string, sessionId: string): Promise<SessionFile> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new Error(`Missing fake session ${sessionId}`);
    return session;
  }

  startSessionExecution(input: StartSessionExecutionInput): ActiveSessionExecution {
    return this.startSessionExecutionMock(input);
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolveValue: (value: T) => void = () => undefined;
  let rejectValue: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for predicate");
}
