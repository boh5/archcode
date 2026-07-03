import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  LoopActiveConflictError,
  ProjectContextResolver,
  ProjectRegistry,
  silentLogger,
  type AgentRuntime,
  type LoopConfig,
  type LoopRunReport,
} from "@archcode/agent-core";
import type { LoopState } from "@archcode/protocol";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "loops-routes");

const manualSessionLoopConfig: LoopConfig = {
  title: "Manual session loop",
  description: "Run on demand",
  schedule: { kind: "manual" },
  runKind: "session",
  mode: "report",
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 4 },
  taskPrompt: "Summarize local project health.",
};

const intervalSessionLoopConfig: LoopConfig = {
  ...manualSessionLoopConfig,
  title: "Interval session loop",
  schedule: { kind: "interval", everyMs: 1_000 },
};

const goalLoopConfig: LoopConfig = {
  title: "Goal loop",
  schedule: { kind: "manual" },
  runKind: "goal",
  mode: "act",
  approvalPolicy: "explicit_per_run",
  limits: { maxIterationsPerRun: 3 },
  goalTemplate: {
    title: "Loop-created goal",
    author: "architect",
    doneConditions: [{ id: "done-file", kind: "file_exists", params: { path: "done.md" } }],
    retryPolicy: { maxRetries: 1, backoffMs: 25, escalateOnFailure: false },
    approvalPoints: ["after_plan"],
    reviewerAgent: "reviewer",
    prompt: "Execute this inline Goal template only.",
  },
};

describe("loops routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("creates and reads a manual session loop without readiness score", async () => {
    const { app, project, runtime } = await createTestApp("manual-session-loop");

    const createRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ config: manualSessionLoopConfig, author: "tester" }),
      headers: { "content-type": "application/json" },
    });
    const createBody = await createRes.json() as { loop: LoopState };

    expect(createRes.status).toBe(201);
    expect(createBody.loop).toMatchObject({ projectId: project.slug, status: "active", config: { title: "Manual session loop", schedule: { kind: "manual" } } });
    expect(createBody.loop.nextRunAt).toBeUndefined();
    expect(createBody.loop.readinessScore ?? null).toBeNull();
    expect(runtime.createLoop).toHaveBeenCalledWith(project.workspaceRoot, manualSessionLoopConfig, "tester");

    const listRes = await app.request(`/api/projects/${project.slug}/loops`);
    const listBody = await listRes.json() as { loops: LoopState[] };
    expect(listRes.status).toBe(200);
    expect(listBody.loops.map((loop) => loop.loopId)).toEqual([createBody.loop.loopId]);

    const readRes = await app.request(`/api/projects/${project.slug}/loops/${createBody.loop.loopId}`);
    expect(readRes.status).toBe(200);
    expect(await readRes.json()).toEqual({ loop: createBody.loop });
  });

  test("creates interval session loops and supported presets at create time only", async () => {
    const { app, project } = await createTestApp("interval-and-preset", { now: 10_000 });

    const intervalRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ config: intervalSessionLoopConfig }),
      headers: { "content-type": "application/json" },
    });
    const intervalBody = await intervalRes.json() as { loop: LoopState };

    expect(intervalRes.status).toBe(201);
    expect(intervalBody.loop.config.schedule).toEqual({ kind: "interval", everyMs: 1_000 });
    expect(intervalBody.loop.nextRunAt).toBeNumber();
    expect(intervalBody.loop.readinessScore ?? null).toBeNull();

    const presetRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ presetId: "daily_triage", author: "preset-user" }),
      headers: { "content-type": "application/json" },
    });
    const presetBody = await presetRes.json() as { loop: LoopState };

    expect(presetRes.status).toBe(201);
    expect(presetBody.loop.config.sourcePreset).toBe("daily_triage");
    expect(presetBody.loop.config.title).toBe("Daily Triage");
    expect(presetBody.loop.readinessScore ?? null).toBeNull();

    const unsupportedRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ presetId: "pr_babysitter" }),
      headers: { "content-type": "application/json" },
    });
    expect(unsupportedRes.status).toBe(400);
    expect(await unsupportedRes.json()).toMatchObject({ error: { code: "BAD_REQUEST", message: expect.stringContaining("Unsupported loop preset: pr_babysitter") } });
  });

  test("creates a goal loop with inline goalTemplate and rejects goalTemplateId", async () => {
    const { app, project } = await createTestApp("goal-loop-inline-template");

    const createRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ config: goalLoopConfig }),
      headers: { "content-type": "application/json" },
    });
    const createBody = await createRes.json() as { loop: LoopState };

    expect(createRes.status).toBe(201);
    expect(createBody.loop.config.runKind).toBe("goal");
    expect(createBody.loop.config.goalTemplate).toMatchObject({ title: "Loop-created goal", author: "architect" });
    expect(createBody.loop.readinessScore ?? null).toBeNull();

    const invalidRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ config: { ...goalLoopConfig, goalTemplateId: "existing-goal" } }),
      headers: { "content-type": "application/json" },
    });
    expect(invalidRes.status).toBe(400);
    expect(await invalidRes.json()).toMatchObject({ error: { code: "BAD_REQUEST", message: "Request body is invalid" } });
  });

  test("rejects active duplicate or cron and event trigger schedules", async () => {
    const { app, project, runtime } = await createTestApp("rejects-active-duplicate-or-cron", { holdRunsOpen: true });
    const loop = await createLoop(app, project.slug, manualSessionLoopConfig);

    const firstTrigger = app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/trigger`, { method: "POST" });
    await runtime.waitForActiveRun();

    const duplicateRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/trigger`, { method: "POST" });
    expect(duplicateRes.status).toBe(409);
    expect(await duplicateRes.json()).toEqual({
      error: {
        code: "LOOP_ACTIVE_CONFLICT",
        message: `Loop ${loop.loopId} already has an active run (run-1); cannot start manual trigger.`,
        details: { loopId: loop.loopId, trigger: "manual", activeRunId: "run-1", sessionId: "session-1" },
      },
    });
    expect(runtime.createLoopRunCount()).toBe(1);

    runtime.releaseActiveRun();
    expect((await (await firstTrigger).json() as { report: LoopRunReport }).report).toMatchObject({ runId: "run-1", sessionId: "session-1", status: "succeeded" });

    for (const schedule of [{ kind: "cron", expression: "* * * * *" }, { kind: "event", event: "pull_request" }]) {
      const res = await app.request(`/api/projects/${project.slug}/loops`, {
        method: "POST",
        body: JSON.stringify({ config: { ...manualSessionLoopConfig, schedule } }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "BAD_REQUEST", message: "Request body is invalid" } });
    }
  });

  test("manual trigger returns deterministic session and goal linkage", async () => {
    const { app, project } = await createTestApp("manual-trigger-linkage");
    const sessionLoop = await createLoop(app, project.slug, manualSessionLoopConfig);
    const goalLoop = await createLoop(app, project.slug, goalLoopConfig);

    const sessionRes = await app.request(`/api/projects/${project.slug}/loops/${sessionLoop.loopId}/trigger`, { method: "POST" });
    const sessionBody = await sessionRes.json() as { report: LoopRunReport };
    expect(sessionRes.status).toBe(200);
    expect(sessionBody.report).toMatchObject({ runId: "run-1", loopId: sessionLoop.loopId, status: "succeeded", trigger: "manual", sessionId: "session-1" });
    expect(sessionBody.report.goalId).toBeUndefined();

    const goalRes = await app.request(`/api/projects/${project.slug}/loops/${goalLoop.loopId}/trigger`, { method: "POST" });
    const goalBody = await goalRes.json() as { report: LoopRunReport };
    expect(goalRes.status).toBe(200);
    expect(goalBody.report).toMatchObject({ runId: "run-2", loopId: goalLoop.loopId, status: "succeeded", trigger: "manual", goalId: "goal-2", sessionId: "goal-session-2" });
  });

  test("pause preserves active run and resume recomputes interval nextRunAt from current runtime time", async () => {
    const { app, project, runtime } = await createTestApp("pause-resume", { now: 50_000, holdRunsOpen: true });
    const loop = await createLoop(app, project.slug, intervalSessionLoopConfig);

    const firstTrigger = app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/trigger`, { method: "POST" });
    await runtime.waitForActiveRun();

    const pauseRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/pause`, { method: "POST" });
    const paused = await pauseRes.json() as { loop: LoopState };
    expect(pauseRes.status).toBe(200);
    expect(paused.loop.status).toBe("paused");
    expect(paused.loop.nextRunAt).toBeUndefined();
    expect(paused.loop.currentRun).toMatchObject({ runId: "run-1", status: "running" });
    expect(runtime.abortSessionExecution).not.toHaveBeenCalled();

    runtime.releaseActiveRun();
    expect((await (await firstTrigger).json() as { report: LoopRunReport }).report.status).toBe("succeeded");

    runtime.setNow(80_000);
    const resumeRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/resume`, { method: "POST" });
    const resumed = await resumeRes.json() as { loop: LoopState };
    expect(resumeRes.status).toBe(200);
    expect(resumed.loop.status).toBe("active");
    expect(resumed.loop.nextRunAt).toBe(81_000);
  });

  test("patch update, run reports, generated state, and invalid paths use stable JSON shapes", async () => {
    const { app, project } = await createTestApp("patch-log-state");
    const loop = await createLoop(app, project.slug, manualSessionLoopConfig);

    const patchRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "paused" }),
      headers: { "content-type": "application/json" },
    });
    expect(patchRes.status).toBe(200);
    expect(await patchRes.json()).toMatchObject({ loop: { loopId: loop.loopId, status: "paused" } });

    for (const internalPatch of [{ nextRunAt: 123_456 }, { generatedStateSummary: "server generated only" }, { runCount: 99 }]) {
      const internalPatchRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}`, {
        method: "PATCH",
        body: JSON.stringify(internalPatch),
        headers: { "content-type": "application/json" },
      });
      expect(internalPatchRes.status).toBe(400);
      expect(await internalPatchRes.json()).toMatchObject({ error: { code: "BAD_REQUEST", message: "Request body is invalid" } });
    }

    await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/trigger`, { method: "POST" });
    const runsRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/runs?limit=1`);
    const runsBody = await runsRes.json() as { runs: LoopRunReport[] };
    expect(runsRes.status).toBe(200);
    expect(runsBody.runs).toEqual([expect.objectContaining({ runId: "run-1", loopId: loop.loopId, status: "succeeded" })]);

    const stateRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/state`);
    const stateBody = await stateRes.json() as { markdown: string; state: LoopState };
    expect(stateRes.status).toBe(200);
    expect(stateBody.markdown).toContain("Manual session loop");
    expect(stateBody.state.loopId).toBe(loop.loopId);
    expect(stateBody.state.readinessScore ?? null).toBeNull();

    const invalidIdRes = await app.request(`/api/projects/${project.slug}/loops/not-a-uuid`);
    expect(invalidIdRes.status).toBe(400);
    expect(await invalidIdRes.json()).toEqual({ error: { code: "BAD_REQUEST", message: "loopId must be a UUID" } });
  });
});

async function createLoop(app: ReturnType<typeof createServerApp>["app"], slug: string, config: LoopConfig): Promise<LoopState> {
  const res = await app.request(`/api/projects/${slug}/loops`, {
    method: "POST",
    body: JSON.stringify({ config }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(201);
  return (await res.json() as { loop: LoopState }).loop;
}

async function createTestApp(testName: string, options: { now?: number; holdRunsOpen?: boolean } = {}) {
  const homeDir = resolve(tempRoot, "homes", testName);
  const workspaceRoot = resolve(tempRoot, "workspaces", testName);
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
  const project = await projectRegistry.add({ workspaceRoot, name: testName });
  const runtime = createTestRuntime(projectRegistry, options);

  return {
    app: createServerApp(runtime, { dev: true }).app,
    project,
    runtime,
    workspaceRoot,
  };
}

function createTestRuntime(projectRegistry: ProjectRegistry, options: { now?: number; holdRunsOpen?: boolean }): AgentRuntime & {
  setNow(value: number): void;
  waitForActiveRun(): Promise<void>;
  releaseActiveRun(): void;
  createLoopRunCount(): number;
} {
  const contextResolver = new ProjectContextResolver({ logger: silentLogger });
  let now = options.now ?? 1_000;
  let runSequence = 0;
  const activeRuns = new Map<string, { runId: string; sessionId?: string }>();
  let activeRunStarted: (() => void) | undefined;
  let activeRunStartedPromise = new Promise<void>((resolveStarted) => {
    activeRunStarted = resolveStarted;
  });
  let releaseActiveRun: (() => void) | undefined;

  const runtime = {
    projectRegistry,
    contextResolver,
    warnings: [],
    mcpManager: undefined,
    toolRegistry: undefined,
    providerRegistry: undefined,
    skillService: undefined,
    hitl: undefined,
    subscribeMcpStatusChanges: mock(() => () => undefined),
    getMcpServerStatuses: mock(() => new Map()),
    createSession: mock(async () => ({ sessionId: crypto.randomUUID(), title: null, createdAt: now, messages: [], steps: [], todos: [], reminders: [], executions: [] })),
    getSessionFile: mock(async (_workspaceRoot: string, sessionId: string) => ({ sessionId, title: null, createdAt: now, messages: [], steps: [], todos: [], reminders: [], executions: [] })),
    listSessions: mock(async () => []),
    startSessionExecution: mock((input: { workspaceRoot: string; sessionId: string }) => ({
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      agentName: "orchestrator",
      origin: "loop",
      abortController: new AbortController(),
      promise: Promise.resolve(),
      executionToken: Symbol("test-execution"),
      startedAt: now,
    })),
    abortSessionExecution: mock(() => false),
    abortSessionExecutionAndWait: mock(async () => undefined),
    abortAllSessionExecutions: mock(async () => undefined),
    isSessionExecutionRunning: mock(() => false),
    getSessionExecution: mock(() => undefined),
    subscribeSessionEvents: mock(() => () => undefined),
    deleteSession: mock(async () => undefined),
    disposeSessionAgent: mock(() => undefined),
    disposeAllSessionAgents: mock(() => undefined),
    isSessionTombstoned: mock(() => false),
    dispatchCommand: mock(async () => null),
    requestPermission: mock(async () => "timeout"),
    respondPermission: mock(() => false),
    requestQuestion: mock(async () => ({ isError: true, reason: "Cancelled" })),
    respondQuestion: mock(() => false),
    cleanupDeferredSession: mock(() => undefined),
    notifyRuntimeShutdown: mock(() => undefined),
    listLoops: mock(async (workspaceRoot: string) => {
      const context = await contextResolver.resolve(workspaceRoot);
      return await context.loopState.list(context.project.slug);
    }),
    readLoop: mock(async (workspaceRoot: string, loopId: string) => (await contextResolver.resolve(workspaceRoot)).loopState.read(loopId)),
    createLoop: mock(async (workspaceRoot: string, config: LoopConfig, author?: string) => {
      const context = await contextResolver.resolve(workspaceRoot);
      return await context.loopState.create(context.project.slug, config, author);
    }),
    updateLoop: mock(async (workspaceRoot: string, loopId: string, updates) => (await contextResolver.resolve(workspaceRoot)).loopState.update(loopId, updates)),
    pauseLoop: mock(async (workspaceRoot: string, loopId: string) => (await contextResolver.resolve(workspaceRoot)).loopState.pause(loopId)),
    resumeLoop: mock(async (workspaceRoot: string, loopId: string) => (await contextResolver.resolve(workspaceRoot)).loopState.resume(loopId, now)),
    triggerLoopRun: mock(async (workspaceRoot: string, loopId: string) => {
      const context = await contextResolver.resolve(workspaceRoot);
      const loop = await context.loopState.read(loopId);
      const existing = activeRuns.get(loopId);
      if (existing !== undefined) throw new LoopActiveConflictError(loopId, "manual", existing.runId, existing.sessionId);

      runSequence += 1;
      const runId = `run-${runSequence}`;
      const sessionId = loop.config.runKind === "goal" ? `goal-session-${runSequence}` : `session-${runSequence}`;
      const startedAt = now;
      const runningReport: LoopRunReport = { runId, loopId, status: "running", trigger: "manual", startedAt, sessionId };
      activeRuns.set(loopId, { runId, sessionId });
      await context.loopState.recordRunStart(loopId, runningReport);
      activeRunStarted?.();

      if (options.holdRunsOpen) {
        await new Promise<void>((resolveRelease) => {
          releaseActiveRun = resolveRelease;
        });
      }

      now += 1;
      const finished: LoopRunReport = {
        ...runningReport,
        status: "succeeded",
        endedAt: now,
        ...(loop.config.runKind === "goal" ? { goalId: `goal-${runSequence}` } : {}),
        summary: `Loop ${loopId} completed in fake runtime.`,
      };
      try {
        await context.loopState.recordRunFinish(loopId, finished);
        return finished;
      } finally {
        activeRuns.delete(loopId);
        activeRunStartedPromise = new Promise<void>((resolveStarted) => {
          activeRunStarted = resolveStarted;
        });
        releaseActiveRun = undefined;
      }
    }),
    readLoopRunLog: mock(async (workspaceRoot: string, loopId: string, limit?: number) => (await contextResolver.resolve(workspaceRoot)).loopState.readRunLog(loopId, limit)),
    readLoopStateMarkdown: mock(async (workspaceRoot: string, loopId: string) => (await contextResolver.resolve(workspaceRoot)).loopState.readGeneratedStateMarkdown(loopId)),
    startLoopSchedulers: mock(async () => undefined),
    stopLoopSchedulers: mock(() => undefined),
    setNow(value: number) {
      now = value;
    },
    waitForActiveRun: () => activeRunStartedPromise,
    releaseActiveRun() {
      releaseActiveRun?.();
    },
    createLoopRunCount: () => runSequence,
  } as unknown as AgentRuntime & {
    setNow(value: number): void;
    waitForActiveRun(): Promise<void>;
    releaseActiveRun(): void;
    createLoopRunCount(): number;
  };

  return runtime;
}
