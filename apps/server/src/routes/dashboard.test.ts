import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import type { GoalState, GoalStatus, LoopState } from "@archcode/protocol";
import { errorHandler } from "../error-handler";
import { createDashboardRoutes } from "./dashboard";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "dashboard-routes");

type RouteRuntime = Parameters<typeof createDashboardRoutes>[0];

interface ProjectInfo {
  slug: string;
  name: string;
  workspaceRoot: string;
  addedAt: string;
}

class FakeGoalStateManager {
  readonly #goals: GoalState[] = [];
  readonly #now = new Date("2026-07-08T00:00:00.000Z").toISOString();

  add(projectId: string, title: string, status: GoalStatus): GoalState {
    const goal: GoalState = {
      id: crypto.randomUUID(),
      projectId,
      title,
      objective: `Objective for ${title}`,
      acceptanceCriteria: `Acceptance criteria for ${title}`,
      status,
      attempt: 1,
      pendingHitlIds: [],
      approvalRefs: [],
      childSessionIds: [],
      createdAt: this.#now,
      updatedAt: this.#now,
      ...(status === "done" ? { completedAt: this.#now } : {}),
      ...(status === "cancelled" ? { cancelledAt: this.#now } : {}),
    };
    this.#goals.push(goal);
    return goal;
  }

  async listGoals(projectId?: string): Promise<GoalState[]> {
    return this.#goals.filter((goal) => projectId === undefined || goal.projectId === projectId);
  }
}

async function createFixture(testName: string) {
  const managers = new Map<string, FakeGoalStateManager>();
  const projects: ProjectInfo[] = [];

  for (const name of ["alpha", "beta"]) {
    const workspaceRoot = resolve(tempRoot, "workspaces", testName, name);
    await mkdir(workspaceRoot, { recursive: true });
    const project: ProjectInfo = {
      slug: `${testName}-${name}`,
      name: `${name} project`,
      workspaceRoot,
      addedAt: new Date("2026-07-08T00:00:00.000Z").toISOString(),
    };
    projects.push(project);
    managers.set(workspaceRoot, new FakeGoalStateManager());
  }

  const runtime = {
    projectRegistry: {
      listProjects: mock(async () => projects),
      list: mock(async () => projects),
    },
    contextResolver: {
      resolve: mock(async (workspaceRoot: string) => {
        const goalState = managers.get(workspaceRoot);
        if (goalState === undefined) throw new Error(`Missing manager for ${workspaceRoot}`);
        return { goalState };
      }),
    },
    listLoops: mock(async () => []),
  } as unknown as RouteRuntime;

  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api", createDashboardRoutes(runtime));

  return { app, managers, projects, runtime };
}

function managerFor(managers: Map<string, FakeGoalStateManager>, project: ProjectInfo): FakeGoalStateManager {
  const manager = managers.get(project.workspaceRoot);
  if (manager === undefined) throw new Error(`Missing manager for ${project.workspaceRoot}`);
  return manager;
}

function addGoal(managers: Map<string, FakeGoalStateManager>, project: ProjectInfo, title: string, status: GoalStatus): GoalState {
  return managerFor(managers, project).add(project.slug, title, status);
}

describe("dashboard routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("GET /api/goals?status=active includes simplified active display statuses", async () => {
    const { app, managers, projects } = await createFixture("active-goals");
    const activeStatuses: GoalStatus[] = ["draft", "running", "blocked", "reviewing", "not_done", "failed"];
    for (const status of activeStatuses) {
      addGoal(managers, projects[0], `${status} goal`, status);
    }
    addGoal(managers, projects[0], "done goal", "done");
    addGoal(managers, projects[1], "cancelled goal", "cancelled");

    const res = await app.request("/api/goals?status=active");
    const body = await res.json() as { goals: Array<GoalState & { projectSlug: string; projectName: string }> };

    expect(res.status).toBe(200);
    expect(body.goals.map((goal) => goal.status).sort()).toEqual([...activeStatuses].sort());
    expect(body.goals).toContainEqual(expect.objectContaining({ title: "draft goal", projectSlug: projects[0].slug, projectName: projects[0].name }));
    expect(body.goals).not.toContainEqual(expect.objectContaining({ status: "done" }));
    expect(body.goals).not.toContainEqual(expect.objectContaining({ status: "cancelled" }));
  });

  test("GET /api/goals?status=terminal includes done and cancelled only", async () => {
    const { app, managers, projects } = await createFixture("terminal-goals");
    addGoal(managers, projects[0], "running goal", "running");
    const done = addGoal(managers, projects[0], "done goal", "done");
    const cancelled = addGoal(managers, projects[1], "cancelled goal", "cancelled");

    const res = await app.request("/api/goals?status=terminal");
    const body = await res.json() as { goals: Array<GoalState & { projectSlug: string; projectName: string }> };

    expect(res.status).toBe(200);
    expect(body.goals.map((goal) => goal.id).sort()).toEqual([cancelled.id, done.id].sort());
    expect(body.goals.map((goal) => goal.status).sort()).toEqual(["cancelled", "done"]);
  });

  test("GET /api/goals supports explicit simplified status filters", async () => {
    const { app, managers, projects } = await createFixture("explicit-status");
    const notDone = addGoal(managers, projects[0], "needs retry", "not_done");
    addGoal(managers, projects[0], "running goal", "running");

    const res = await app.request("/api/goals?status=not_done");
    const body = await res.json() as { goals: Array<GoalState & { projectSlug: string; projectName: string }> };

    expect(res.status).toBe(200);
    expect(body.goals).toHaveLength(1);
    expect(body.goals[0]).toMatchObject({ id: notDone.id, status: "not_done", projectSlug: projects[0].slug, projectName: projects[0].name });
  });

  test("GET /api/goals rejects old Goal statuses", async () => {
    const { app } = await createFixture("old-statuses");

    for (const status of ["locked", "verifying", "reviewed", "completed", "escalated", "paused"]) {
      const res = await app.request(`/api/goals?status=${status}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: "BAD_REQUEST", message: "status must be active, terminal, or a valid goal status" },
      });
    }
  });

  test("GET /api/goals reports per-project aggregation errors without blocking healthy projects", async () => {
    const { app, managers, projects, runtime } = await createFixture("partial-failure");
    const healthy = addGoal(managers, projects[0], "healthy goal", "running");
    (runtime.contextResolver.resolve as ReturnType<typeof mock>).mockImplementation(async (workspaceRoot: string) => {
      if (workspaceRoot === projects[1].workspaceRoot) throw new Error("corrupt goal state");
      return { goalState: managerFor(managers, projects[0]) };
    });

    const res = await app.request("/api/goals");
    const body = await res.json() as {
      goals: Array<GoalState & { projectSlug: string; projectName: string }>;
      errors: Array<{ projectSlug: string; projectName: string; message: string }>;
    };

    expect(res.status).toBe(200);
    expect(body.goals).toContainEqual(expect.objectContaining({ id: healthy.id, projectSlug: projects[0].slug }));
    expect(body.errors).toContainEqual(expect.objectContaining({
      projectSlug: projects[1].slug,
      projectName: projects[1].name,
      message: "corrupt goal state",
    }));
  });

  test("GET /api/loops exposes simplified summaries without raw scheduler internals", async () => {
    const { app, projects, runtime } = await createFixture("loop-smoke");
    const loop: LoopState = {
      loopId: crypto.randomUUID(),
      projectId: projects[0].slug,
      config: {
        templateId: "watch_report",
        title: "Daily loop",
        schedule: { kind: "manual" },
        approvalPolicy: "interactive",
        limits: { maxIterationsPerRun: 1 },
      },
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runCount: 0,
      stateVersion: 1,
      currentRun: {
        runId: "run-current",
        loopId: "00000000-0000-4000-8000-000000000001",
        status: "needs_user",
        trigger: "on_pr",
        startedAt: 1_000,
        jobId: "job-current",
        triggerKind: "on_pr",
        subjectKey: "pr:owner/repo#42",
        dedupeKey: "loop:on_pr:pr:owner/repo#42",
        branchKey: "github:owner/repo:main",
        cleanupState: "preserved",
        blockedReason: "waiting for approval",
      },
      lastRun: {
        runId: "run-last",
        loopId: "00000000-0000-4000-8000-000000000001",
        status: "succeeded",
        trigger: "cron",
        startedAt: 500,
        endedAt: 750,
        summary: "Loop completed.",
        jobId: "job-last",
        subjectKey: "branch:main",
        dedupeKey: "loop:cron:main",
        cleanupState: "cleaned",
      },
      currentJob: {
        jobId: "job-current",
        loopId: "00000000-0000-4000-8000-000000000001",
        status: "blocked",
        triggerKind: "on_pr",
        subjectKey: "pr:owner/repo#42",
        dedupeKey: "loop:on_pr:pr:owner/repo#42",
        branchKey: "github:owner/repo:main",
        queuedAt: 1_000,
        attempts: 1,
        cleanupState: "preserved",
      },
      queuedJobs: [{
        jobId: "job-queued",
        loopId: "00000000-0000-4000-8000-000000000001",
        status: "queued",
        triggerKind: "on_ci_fail",
        subjectKey: "ci:owner/repo:deadbeef",
        dedupeKey: "loop:on_ci_fail:ci:owner/repo:deadbeef",
        queuedAt: 1_100,
        attempts: 0,
        cleanupState: "expired_needs_review",
      }],
      triggerHealth: [{ triggerKind: "on_pr", status: "blocked", cadenceMs: 60_000, lastCheckedAt: 1_200 }],
      cleanupState: "cleanup_candidate",
    };
    (runtime.listLoops as ReturnType<typeof mock>).mockImplementation(async (workspaceRoot: string) => workspaceRoot === projects[0].workspaceRoot ? [loop] : []);

    const res = await app.request("/api/loops?status=active");
    const body = await res.json() as { loops: Array<Record<string, unknown>> };
    const serialized = JSON.stringify(body);

    expect(res.status).toBe(200);
    expect(body.loops).toContainEqual(expect.objectContaining({
      loopId: loop.loopId,
      title: "Daily loop",
      status: "active",
      templateId: "watch_report",
      projectSlug: projects[0].slug,
      projectName: projects[0].name,
    }));
    expect(body.loops[0]?.currentRun).toEqual({ runId: "run-current", status: "needs_user", startedAt: 1_000 });
    expect(body.loops[0]?.lastRun).toEqual({ runId: "run-last", status: "succeeded", startedAt: 500, endedAt: 750, summary: "Loop completed." });
    expect(body.loops[0]).not.toHaveProperty("config");
    expect(body.loops[0]).not.toHaveProperty("currentJob");
    expect(body.loops[0]).not.toHaveProperty("queuedJobs");
    expect(body.loops[0]).not.toHaveProperty("triggerHealth");
    expect(body.loops[0]).not.toHaveProperty("cleanupState");
    expect(serialized).not.toContain("runKind");
    expect(serialized).not.toContain("mode");
    expect(serialized).not.toContain("currentJob");
    expect(serialized).not.toContain("queuedJobs");
    expect(serialized).not.toContain("triggerHealth");
    expect(serialized).not.toContain("cleanupState");
    expect(serialized).not.toContain("job-current");
    expect(serialized).not.toContain("job-queued");
    expect(serialized).not.toContain("subjectKey");
    expect(serialized).not.toContain("dedupeKey");
    expect(serialized).not.toContain("branchKey");
    expect(serialized).not.toContain("pr:owner/repo#42");
  });
});
