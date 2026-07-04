import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpManager } from "./mcp";
import { setLlmAdapterForTest } from "./llm";
import { createRuntime, type AgentRuntime } from "./runtime";
import { LoopActiveConflictError } from "./loops/runner";
import type { LoopSchedulerTimer } from "./loops/scheduler";
import type { LoopConfig } from "./loops/state";
import { __setSessionsDirForTest } from "./store/sessions-dir";

const tmpRoots: string[] = [];

const intervalLoopConfig: LoopConfig = {
  title: "Runtime interval loop",
  schedule: { kind: "interval", everyMs: 100 },
  runKind: "session",
  mode: "report",
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 4 },
  taskPrompt: "Summarize the project.",
};

const manualLoopConfig: LoopConfig = {
  ...intervalLoopConfig,
  title: "Runtime manual loop",
  schedule: { kind: "manual" },
};

const goalLoopConfig: LoopConfig = {
  title: "Runtime goal loop",
  schedule: { kind: "manual" },
  runKind: "goal",
  mode: "act",
  approvalPolicy: "explicit_per_run",
  limits: { maxIterationsPerRun: 3 },
  goalTemplate: {
    title: "Runtime-created Goal",
    author: "architect",
    doneConditions: [{ id: "done-file", kind: "file_exists", params: { path: "done.md" } }],
    retryPolicy: { maxRetries: 1, backoffMs: 10, escalateOnFailure: false },
    approvalPoints: [],
    reviewerAgent: "reviewer",
    prompt: "Use runtime execution plumbing.",
  },
};

beforeEach(() => {
  __setSessionsDirForTest(undefined);
  installLlmMocks();
});

afterEach(() => {
  setLlmAdapterForTest(undefined);
});

afterAll(() => {
  __setSessionsDirForTest(undefined);
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

describe("AgentRuntime Loop wiring", () => {
  test("createSession persists loopId and listSessions summaries expose loopId", async () => {
    const fixture = await createRuntimeFixture();
    const loopId = crypto.randomUUID();

    const session = await fixture.runtime.createSession(fixture.workspaceRoot, {
      loopId,
      sessionRole: "main",
      title: "Loop session",
    });
    const persisted = await readPersistedSession(join(fixture.sessionsDir, `${session.sessionId}.json`));
    const summaries = await fixture.runtime.listSessions(fixture.workspaceRoot);

    expect(session.loopId).toBe(loopId);
    expect(persisted.loopId).toBe(loopId);
    expect(summaries).toContainEqual(expect.objectContaining({ sessionId: session.sessionId, loopId }));
  });

  test("startLoopSchedulers schedules enabled active interval loops for registered projects only", async () => {
    const fixture = await createRuntimeFixture({ now: 1_000 });
    const registered = await fixture.runtime.projectRegistry.add({ workspaceRoot: fixture.workspaceRoot, name: "Registered" });
    const unregisteredWorkspace = await makeTempDir("archcode-runtime-unregistered-");

    const activeLoop = await fixture.runtime.createLoop(fixture.workspaceRoot, intervalLoopConfig);
    const manualLoop = await fixture.runtime.createLoop(fixture.workspaceRoot, manualLoopConfig);
    const pausedLoop = await fixture.runtime.createLoop(fixture.workspaceRoot, { ...intervalLoopConfig, title: "Paused loop" });
    await fixture.runtime.pauseLoop(fixture.workspaceRoot, pausedLoop.loopId);

    const unregisteredRuntimeView = await fixture.runtime.contextResolver.resolve(unregisteredWorkspace);
    const unregisteredLoop = await unregisteredRuntimeView.loopState.create("unregistered", {
      ...intervalLoopConfig,
      title: "Unregistered loop",
    });

    await fixture.runtime.startLoopSchedulers();

    expect(registered.workspaceRoot).toBe(fixture.workspaceRoot);
    expect(fixture.timer.size()).toBe(1);
    expect((await fixture.runtime.readLoop(fixture.workspaceRoot, activeLoop.loopId)).status).toBe("active");
    expect((await fixture.runtime.readLoop(fixture.workspaceRoot, manualLoop.loopId)).nextRunAt).toBeUndefined();
    expect((await fixture.runtime.readLoop(fixture.workspaceRoot, pausedLoop.loopId)).status).toBe("paused");
    expect(await unregisteredRuntimeView.loopState.read(unregisteredLoop.loopId)).toEqual(expect.objectContaining({ loopId: unregisteredLoop.loopId }));
  });

  test("scheduler shutdown clears timers and prevents scheduled runs", async () => {
    const fixture = await createRuntimeFixture({ now: 0 });
    await fixture.runtime.projectRegistry.add({ workspaceRoot: fixture.workspaceRoot, name: "Registered" });
    const loop = await fixture.runtime.createLoop(fixture.workspaceRoot, intervalLoopConfig);
    await fixture.runtime.updateLoop(fixture.workspaceRoot, loop.loopId, { nextRunAt: 100 });

    await fixture.runtime.startLoopSchedulers();
    expect(fixture.timer.size()).toBe(1);

    fixture.runtime.stopLoopSchedulers();
    expect(fixture.timer.size()).toBe(0);

    await fixture.timer.advanceTo(100);
    const reports = await fixture.runtime.readLoopRunLog(fixture.workspaceRoot, loop.loopId);

    expect(fixture.startedExecutions).toEqual([]);
    expect(reports).toEqual([]);
  });

  test("triggerLoopRun executes Goal loop main session through runtime execution manager", async () => {
    const fixture = await createRuntimeFixture();
    const loop = await fixture.runtime.createLoop(fixture.workspaceRoot, goalLoopConfig);

    const report = await fixture.runtime.triggerLoopRun(fixture.workspaceRoot, loop.loopId);

    expect(report?.status).toBe("succeeded");
    expect(typeof report?.goalId).toBe("string");
    expect(typeof report?.sessionId).toBe("string");
    const sessionId = report?.sessionId;
    if (sessionId === undefined) throw new Error("Expected Goal loop report to include sessionId");
    const persisted = await readPersistedSession(join(fixture.sessionsDir, `${sessionId}.json`));
    expect(persisted).toMatchObject({
      sessionId,
      goalId: report?.goalId,
      loopId: loop.loopId,
      sessionRole: "main",
      title: "Loop Goal: Runtime goal loop",
    });
    expect(persisted.executions).toEqual([expect.objectContaining({ status: "completed" })]);
  });

  test("triggerLoopRun rejects overlapping manual trigger through real scheduler without skipped report", async () => {
    const fixture = await createRuntimeFixture();
    const loop = await fixture.runtime.createLoop(fixture.workspaceRoot, manualLoopConfig);
    const streamStarted = createDeferred<void>();
    const releaseStream = createDeferred<void>();
    setLlmAdapterForTest({
      streamText: mock(() => ({
        fullStream: (async function* () {
          streamStarted.resolve();
          await releaseStream.promise;
          yield { type: "text-delta", text: "Manual loop execution complete." };
        })(),
        finishReason: releaseStream.promise.then(() => "stop"),
        usage: releaseStream.promise.then(() => ({ totalTokens: 1 })),
        text: releaseStream.promise.then(() => "Manual loop execution complete."),
        toolCalls: Promise.resolve([]),
      })) as never,
      generateText: mock(async () => ({ text: "Runtime manual loop" })) as never,
    });

    const firstRun = fixture.runtime.triggerLoopRun(fixture.workspaceRoot, loop.loopId);
    await streamStarted.promise;

    const conflict = await captureAsyncError(() => fixture.runtime.triggerLoopRun(fixture.workspaceRoot, loop.loopId));
    expect(conflict).toBeInstanceOf(LoopActiveConflictError);
    expect(conflict).toMatchObject({
      code: "LOOP_ACTIVE_CONFLICT",
      loopId: loop.loopId,
      trigger: "manual",
    });
    expect((conflict as LoopActiveConflictError).activeRunId).toBeString();
    expect((conflict as LoopActiveConflictError).activeRunId).not.toBe("");
    expect(await fixture.runtime.readLoopRunLog(fixture.workspaceRoot, loop.loopId)).toEqual([]);

    releaseStream.resolve();
    const firstReport = await firstRun;

    expect(firstReport).toMatchObject({ status: "succeeded", trigger: "manual" });
    const reports = await fixture.runtime.readLoopRunLog(fixture.workspaceRoot, loop.loopId);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ runId: firstReport?.runId, status: "succeeded", trigger: "manual" });
    expect(reports.some((report) => report.status === "skipped" && report.trigger === "manual")).toBe(false);
  });

  test("runtime global kill persists, blocks manual trigger, and clear preserves paused loops", async () => {
    const fixture = await createRuntimeFixture({ now: 1_000 });
    const active = await fixture.runtime.createLoop(fixture.workspaceRoot, manualLoopConfig);
    const paused = await fixture.runtime.createLoop(fixture.workspaceRoot, { ...intervalLoopConfig, title: "Runtime paused loop" });
    await fixture.runtime.pauseLoop(fixture.workspaceRoot, paused.loopId);

    const activated = await fixture.runtime.activateLoopGlobalKill(fixture.workspaceRoot, {
      activatedBy: "runtime-test",
      reason: "maintenance",
    });
    const blocked = await fixture.runtime.triggerLoopRun(fixture.workspaceRoot, active.loopId);

    expect(activated).toMatchObject({ globalKillActive: true, activatedAt: 1_000, activatedBy: "runtime-test", reason: "maintenance" });
    expect(await fixture.runtime.readLoopKillState(fixture.workspaceRoot)).toEqual(activated);
    expect(blocked).toMatchObject({ status: "skipped", reason: "global_kill_active", trigger: "manual" });

    const cleared = await fixture.runtime.clearLoopGlobalKill(fixture.workspaceRoot);
    const accepted = await fixture.runtime.triggerLoopRun(fixture.workspaceRoot, active.loopId);

    expect(cleared).toEqual({ globalKillActive: false });
    expect((await fixture.runtime.readLoop(fixture.workspaceRoot, paused.loopId)).status).toBe("paused");
    expect(accepted).toMatchObject({ status: "succeeded", trigger: "manual" });
  });
});

function installLlmMocks(): void {
  setLlmAdapterForTest({
    streamText: mock(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "Goal loop execution complete." };
      })(),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ totalTokens: 1 }),
      text: Promise.resolve("Goal loop execution complete."),
      toolCalls: Promise.resolve([]),
    })) as never,
    generateText: mock(async () => ({ text: "Runtime goal loop" })) as never,
  });
}

async function createRuntimeFixture(options: { now?: number } = {}): Promise<{
  runtime: AgentRuntime;
  workspaceRoot: string;
  sessionsDir: string;
  timer: FakeTimer;
  startedExecutions: string[];
}> {
  const root = await makeTempDir("archcode-runtime-loops-");
  const workspaceRoot = join(root, "workspace");
  const sessionsDir = join(root, "sessions");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  __setSessionsDirForTest(() => sessionsDir);

  const configPath = join(root, ".archcode.json");
  await writeFile(configPath, JSON.stringify(makeConfig()));
  const clock = new FakeClock(options.now ?? 0);
  const timer = new FakeTimer(clock);
  const runtime = await createRuntime({
    configPath,
    workspaceRoot,
    projectRegistryHomeDir: root,
    mcpManagerFactory: () => makeMcpManager(),
    loopSchedulerClock: clock,
    loopSchedulerTimer: timer,
  });

  return { runtime, workspaceRoot, sessionsDir, timer, startedExecutions: [] };
}

async function makeTempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tmpRoots.push(root);
  return root;
}

async function readPersistedSession(path: string): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      lastError = error;
      await Promise.resolve();
    }
  }
  throw lastError;
}

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function captureAsyncError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw");
}

function makeConfig(): Record<string, unknown> {
  return {
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local LLM",
        options: {
          baseURL: "http://localhost:8090/v1",
          apiKey: "test-key",
        },
        models: {
          "test-model": {
            name: "Test Model",
            limit: { context: 128000, output: 8192 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    agents: {
      orchestrator: { model: "local:test-model" },
      plan: { model: "local:test-model" },
      build: { model: "local:test-model" },
      reviewer: { model: "local:test-model" },
      explore: { model: "local:test-model" },
      librarian: { model: "local:test-model" },
    },
    mcp: { servers: {} },
  };
}

function makeMcpManager(): McpManager {
  return {
    discover: mock(async () => ({ descriptors: [], warnings: [] })),
    closeAll: mock(async () => []),
    getStatus: mock(() => new Map()),
    onStatusChange: mock(() => () => {}),
    startBackgroundDiscovery: mock(() => {}),
  } as unknown as McpManager;
}

class FakeClock {
  constructor(private value: number) {}

  now(): number {
    return this.value;
  }

  set(value: number): void {
    this.value = value;
  }
}

class FakeTimer implements LoopSchedulerTimer {
  readonly #tasks = new Map<number, { dueAt: number; callback: () => void | Promise<void> }>();
  #nextId = 1;

  constructor(private readonly clock: FakeClock) {}

  schedule(delayMs: number, callback: () => void | Promise<void>): { id: number } {
    const id = this.#nextId++;
    this.#tasks.set(id, { dueAt: this.clock.now() + delayMs, callback });
    return { id };
  }

  cancel(handle: { id?: unknown }): void {
    if (typeof handle.id === "number") this.#tasks.delete(handle.id);
  }

  async advanceTo(now: number): Promise<void> {
    while (true) {
      const next = this.nextTaskBefore(now);
      if (!next) break;
      await this.fireTask(next);
    }
    if (this.clock.now() < now) this.clock.set(now);
  }

  size(): number {
    return this.#tasks.size;
  }

  private nextTaskBefore(now: number): { id: number; task: { dueAt: number; callback: () => void | Promise<void> } } | undefined {
    let next: { id: number; task: { dueAt: number; callback: () => void | Promise<void> } } | undefined;
    for (const [id, task] of this.#tasks) {
      if (task.dueAt > now) continue;
      if (!next || task.dueAt < next.task.dueAt) next = { id, task };
    }
    return next;
  }

  private async fireTask(taskEntry: { id: number; task: { dueAt: number; callback: () => void | Promise<void> } }): Promise<void> {
    this.clock.set(taskEntry.task.dueAt);
    this.#tasks.delete(taskEntry.id);
    await taskEntry.task.callback();
  }
}
