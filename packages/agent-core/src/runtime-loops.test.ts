import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GlobalSSEResourceChangedEvent } from "@archcode/protocol";

import type { McpManager } from "./mcp";
import { setLlmAdapterForTest } from "./llm";
import { createRuntime, type AgentRuntime } from "./runtime";
import { LoopActiveConflictError } from "./loops/runner";
import type { LoopSchedulerTimer } from "./loops/scheduler";
import type { LoopConfig } from "./loops/state";
import { __setSessionsDirForTest } from "./store/sessions-dir";

const tmpRoots: string[] = [];

const intervalLoopConfig: LoopConfig = {
  templateId: "watch_report",
  title: null,
  schedule: { kind: "interval", everyMs: 100 },
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 4 },
  taskPrompt: "Summarize the project.",
};

const manualLoopConfig: LoopConfig = {
  ...intervalLoopConfig,
  schedule: { kind: "manual" },
};

const goalLoopConfig: LoopConfig = {
  templateId: "goal_runner",
  title: null,
  schedule: { kind: "manual" },
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 3 },
  goalTemplate: {
    title: null,
    objective: "Use runtime execution plumbing.",
    acceptanceCriteria: "Reviewer can decide DONE from the runtime execution result.",
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
    const persisted = await readPersistedSession(join(fixture.sessionsDir, session.sessionId, "session.json"));
    const summaries = await fixture.runtime.listSessions(fixture.workspaceRoot);

    expect(session.loopId).toBe(loopId);
    expect(persisted.loopId).toBe(loopId);
    expect(summaries).toContainEqual(expect.objectContaining({ sessionId: session.sessionId, loopId }));
  });

  test("queueGoalTitleGeneration stores async title metadata and publishes resource change", async () => {
    const { generateText } = installLlmMocks("Generated Goal Title");
    const fixture = await createRuntimeFixture();
    const projectContext = await fixture.runtime.contextResolver.resolve(fixture.workspaceRoot);
    const goal = await projectContext.goalState.create({
      projectId: projectContext.project.slug,
      objective: "Generate a concise title for this Goal.",
      acceptanceCriteria: "The title is metadata and does not affect execution.",
    });
    const events: GlobalSSEResourceChangedEvent[] = [];
    const unsubscribe = fixture.runtime.subscribeResourceChanges?.((event) => events.push(event));

    try {
      fixture.runtime.queueGoalTitleGeneration?.(fixture.workspaceRoot, goal.id);
      await waitFor(async () => (await projectContext.goalState.read(goal.id)).title === "Generated Goal Title");
    } finally {
      unsubscribe?.();
    }

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "resource.changed",
      projectSlug: projectContext.project.slug,
      resourceType: "goal",
      resourceId: goal.id,
      reason: "title_generated",
    });
  });

  test("queueGoalTitleGeneration skips existing title metadata without model call", async () => {
    const { generateText } = installLlmMocks("Should Not Run");
    const fixture = await createRuntimeFixture();
    const projectContext = await fixture.runtime.contextResolver.resolve(fixture.workspaceRoot);
    const goal = await projectContext.goalState.create({
      projectId: projectContext.project.slug,
      objective: "Already has title metadata.",
      acceptanceCriteria: "Existing title metadata is never overwritten.",
    });
    await projectContext.goalState.setTitleIfEmpty(goal.id, "Existing Title");
    const events: GlobalSSEResourceChangedEvent[] = [];
    const unsubscribe = fixture.runtime.subscribeResourceChanges?.((event) => events.push(event));

    try {
      fixture.runtime.queueGoalTitleGeneration?.(fixture.workspaceRoot, goal.id);
      await Bun.sleep(10);
    } finally {
      unsubscribe?.();
    }

    expect(generateText).not.toHaveBeenCalled();
    expect((await projectContext.goalState.read(goal.id)).title).toBe("Existing Title");
    expect(events).toEqual([]);
  });

  test("createLoop keeps title null when generated title normalizes empty", async () => {
    const { generateText } = installLlmMocks("   ");
    const fixture = await createRuntimeFixture();
    const projectContext = await fixture.runtime.contextResolver.resolve(fixture.workspaceRoot);
    const events: GlobalSSEResourceChangedEvent[] = [];
    const unsubscribe = fixture.runtime.subscribeResourceChanges?.((event) => events.push(event));

    let loopId = "";
    try {
      const loop = await fixture.runtime.createLoop(fixture.workspaceRoot, manualLoopConfig);
      loopId = loop.loopId;
      await waitFor(() => generateText.mock.calls.length > 0);
      await Bun.sleep(10);
    } finally {
      unsubscribe?.();
    }

    expect((await projectContext.loopState.read(loopId)).config.title).toBeNull();
    expect(events).toEqual([]);
  });

  test("startLoopSchedulers schedules enabled active interval loops for registered projects only", async () => {
    const fixture = await createRuntimeFixture({ now: 1_000 });
    const registered = await fixture.runtime.projectRegistry.add({ workspaceRoot: fixture.workspaceRoot, name: "Registered" });
    const unregisteredWorkspace = await makeTempDir("archcode-runtime-unregistered-");

    const activeLoop = await fixture.runtime.createLoop(fixture.workspaceRoot, intervalLoopConfig);
    const manualLoop = await fixture.runtime.createLoop(fixture.workspaceRoot, manualLoopConfig);
    const pausedLoop = await fixture.runtime.createLoop(fixture.workspaceRoot, intervalLoopConfig);
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

  test("single-flights concurrent cold Loop scheduler construction", async () => {
    const fixture = await createRuntimeFixture();
    const originalResolve = fixture.runtime.contextResolver.resolve.bind(fixture.runtime.contextResolver);
    const firstResolveEntered = createDeferred();
    const releaseFirstResolve = createDeferred();
    let resolveCalls = 0;
    const resolve = mock(async (workspaceRoot: string) => {
      resolveCalls += 1;
      if (resolveCalls === 1) {
        firstResolveEntered.resolve();
        await releaseFirstResolve.promise;
      }
      return await originalResolve(workspaceRoot);
    });
    fixture.runtime.contextResolver.resolve = resolve;

    const first = fixture.runtime.readLoopKillState(fixture.workspaceRoot);
    await firstResolveEntered.promise;
    const second = fixture.runtime.readLoopKillState(fixture.workspaceRoot);
    await Bun.sleep(5);
    releaseFirstResolve.resolve();
    await Promise.all([first, second]);

    // One scheduler build resolves the context once directly and once for its
    // LoopRunner. A second cold build would double this to four calls.
    expect(resolve).toHaveBeenCalledTimes(2);
    await fixture.runtime.stopLoopSchedulers();
  });

  test("evicts a failed Loop scheduler build so a later call can retry", async () => {
    const fixture = await createRuntimeFixture();
    const originalResolve = fixture.runtime.contextResolver.resolve.bind(fixture.runtime.contextResolver);
    let resolveCalls = 0;
    fixture.runtime.contextResolver.resolve = mock(async (workspaceRoot: string) => {
      resolveCalls += 1;
      if (resolveCalls === 1) throw new Error("transient context failure");
      return await originalResolve(workspaceRoot);
    });

    await expect(fixture.runtime.readLoopKillState(fixture.workspaceRoot))
      .rejects.toThrow("transient context failure");
    expect(await fixture.runtime.readLoopKillState(fixture.workspaceRoot))
      .toEqual({ globalKillActive: false });
    expect(resolveCalls).toBe(3);
    await fixture.runtime.stopLoopSchedulers();
  });

  test("scheduler shutdown clears timers and prevents scheduled runs", async () => {
    const fixture = await createRuntimeFixture({ now: 0 });
    await fixture.runtime.projectRegistry.add({ workspaceRoot: fixture.workspaceRoot, name: "Registered" });
    const loop = await fixture.runtime.createLoop(fixture.workspaceRoot, intervalLoopConfig);
    await fixture.runtime.updateLoop(fixture.workspaceRoot, loop.loopId, { nextRunAt: 100 });

    await fixture.runtime.startLoopSchedulers();
    expect(fixture.timer.size()).toBe(1);

    await fixture.runtime.stopLoopSchedulers();
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
    const persisted = await readPersistedSession(join(fixture.sessionsDir, sessionId, "session.json"));
    expect(persisted).toMatchObject({
      sessionId,
      goalId: report?.goalId,
      loopId: loop.loopId,
      sessionRole: "main",
    });
    expect(persisted.title).not.toBe(`Loop Goal: ${loop.config.title}`);
    expect(persisted.title).not.toBe(`Goal: ${loop.config.goalTemplate?.title}`);
    expect(persisted.executions).toEqual([expect.objectContaining({ status: "completed" })]);
  });

  test("worktree cleanup migrates the canonical Session cwd before deleting its checkout", async () => {
    const fixture = await createRuntimeFixture();
    await initializeGitRepo(fixture.workspaceRoot);
    const loop = await fixture.runtime.createLoop(fixture.workspaceRoot, {
      ...manualLoopConfig,
      useWorktree: true,
      cleanupPolicy: { deleteUnchangedWorktrees: true },
    });

    const report = await fixture.runtime.triggerLoopRun(fixture.workspaceRoot, loop.loopId);
    const sessionId = report?.sessionId;
    const worktreePath = report?.worktreePath;
    if (sessionId === undefined || worktreePath === undefined) throw new Error("Expected cleaned Loop worktree session");

    expect(report).toMatchObject({ status: "succeeded", cleanupState: "cleaned" });
    expect((await fixture.runtime.getSessionFile(fixture.workspaceRoot, sessionId)).cwd).toBe(fixture.workspaceRoot);
    expect(await pathExists(worktreePath)).toBe(false);
  });

  test("worktree cleanup migrates every old and retry Session that still references the checkout", async () => {
    const fixture = await createRuntimeFixture();
    await initializeGitRepo(fixture.workspaceRoot);
    const loop = await fixture.runtime.createLoop(fixture.workspaceRoot, {
      ...manualLoopConfig,
      useWorktree: true,
      cleanupPolicy: { deleteUnchangedWorktrees: true },
    });
    let oldSessionId: string | undefined;
    setLlmAdapterForTest({
      streamText: mock(() => ({
        fullStream: (async function* () {
          const retrySession = (await fixture.runtime.listSessions(fixture.workspaceRoot)).find(
            (session) => session.loopId === loop.loopId && session.cwd !== fixture.workspaceRoot,
          );
          if (retrySession?.cwd === undefined) throw new Error("Expected retry Session to reference the Loop worktree");
          const oldSession = await fixture.runtime.createSession(fixture.workspaceRoot, {
            cwd: retrySession.cwd,
            loopId: loop.loopId,
            sessionRole: "main",
            title: "Interrupted Loop attempt",
          });
          oldSessionId = oldSession.sessionId;
          yield { type: "text-delta", text: "Loop retry complete." };
        })(),
        finishReason: Promise.resolve("stop"),
        usage: Promise.resolve({ totalTokens: 1 }),
        text: Promise.resolve("Loop retry complete."),
        toolCalls: Promise.resolve([]),
      })) as never,
      generateText: mock(async () => ({ text: "Runtime retry loop" })) as never,
    });

    const report = await fixture.runtime.triggerLoopRun(fixture.workspaceRoot, loop.loopId);
    const retrySessionId = report?.sessionId;
    const worktreePath = report?.worktreePath;
    if (retrySessionId === undefined || oldSessionId === undefined || worktreePath === undefined) {
      throw new Error("Expected cleanup report and old Session");
    }

    expect(report).toMatchObject({ status: "succeeded", cleanupState: "cleaned" });
    expect((await fixture.runtime.getSessionFile(fixture.workspaceRoot, retrySessionId)).cwd).toBe(fixture.workspaceRoot);
    expect((await fixture.runtime.getSessionFile(fixture.workspaceRoot, oldSessionId)).cwd).toBe(fixture.workspaceRoot);
    expect(await pathExists(worktreePath)).toBe(false);
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
    const paused = await fixture.runtime.createLoop(fixture.workspaceRoot, intervalLoopConfig);
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

function installLlmMocks(generatedTitle = "Runtime goal loop"): { generateText: ReturnType<typeof mock> } {
  const generateText = mock(async () => ({ text: generatedTitle }));
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
    generateText: generateText as never,
  });
  return { generateText };
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
      await Bun.sleep(2);
    }
  }
  throw lastError;
}

async function initializeGitRepo(cwd: string): Promise<void> {
  await git(cwd, ["init", "--initial-branch=main"]);
  await git(cwd, ["config", "user.email", "runtime-loop@example.com"]);
  await git(cwd, ["config", "user.name", "Runtime Loop"]);
  await writeFile(join(cwd, "README.md"), "# Runtime Loop\n");
  await git(cwd, ["add", "README.md"]);
  await git(cwd, ["commit", "-m", "initial commit"]);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" } });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
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

async function waitFor(predicate: () => boolean | Promise<boolean>, attempts = 40): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for condition");
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
