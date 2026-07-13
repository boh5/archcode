import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import type { Automation, GoalState, GoalStatus } from "@archcode/protocol";
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

  commit(input: {
    id: string;
    projectId: string;
    createdFromSessionId: string;
    objective: string;
    acceptanceCriteria: string;
    mainSessionId: string;
    useWorktree?: boolean;
  }, title: string, status: GoalStatus): GoalState {
    const goal: GoalState = {
      version: 4,
      id: input.id,
      projectId: input.projectId,
      createdFromSessionId: input.createdFromSessionId,
      title,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      useWorktree: input.useWorktree ?? false,
      status,
      attempt: 1,
      reviewGeneration: 0,
      pendingHitlIds: [],
      approvalRefs: [],
      appliedHitlIds: [],
      mainSessionId: input.mainSessionId,
      childSessionIds: [],
      createdAt: this.#now,
      updatedAt: this.#now,
      startedAt: this.#now,
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
      listProjects: mock(async () => {
        throw new Error("legacy listProjects alias must not be called");
      }),
      list: mock(async () => projects),
    },
    contextResolver: {
      resolve: mock(async (workspaceRoot: string) => {
        const goalState = managers.get(workspaceRoot);
        if (goalState === undefined) throw new Error(`Missing manager for ${workspaceRoot}`);
        return { goalState };
      }),
    },
    listAutomations: mock(async () => []),
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
  const id = crypto.randomUUID();
  return managerFor(managers, project).commit({
    id,
    projectId: project.slug,
    createdFromSessionId: `source-${id}`,
    mainSessionId: `main-${id}`,
    objective: `Objective for ${title}`,
    acceptanceCriteria: `Acceptance criteria for ${title}`,
  }, title, status);
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
    const activeStatuses: GoalStatus[] = ["running", "reviewing", "not_done", "failed"];
    for (const status of activeStatuses) {
      addGoal(managers, projects[0], `${status} goal`, status);
    }
    addGoal(managers, projects[0], "done goal", "done");
    addGoal(managers, projects[1], "cancelled goal", "cancelled");

    const res = await app.request("/api/goals?status=active");
    const body = await res.json() as { goals: Array<GoalState & { projectSlug: string; projectName: string }> };

    expect(res.status).toBe(200);
    expect(body.goals.map((goal) => goal.status).sort()).toEqual([...activeStatuses].sort());
    expect(body.goals).toContainEqual(expect.objectContaining({ title: "running goal", projectSlug: projects[0].slug, projectName: projects[0].name }));
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

  test("GET /api/automations aggregates active automations by project", async () => {
    const { app, projects, runtime } = await createFixture("automation-smoke");
    const automation: Automation = {
      id: crypto.randomUUID(),
      projectId: projects[0].slug,
      createdFromSessionId: "session-source-automation",
      name: "Daily check-in",
      trigger: { kind: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
      action: { kind: "start_session", message: "Review the open work.", location: "project" },
      status: "active",
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
      nextFireAt: "2026-07-09T01:00:00.000Z",
    };
    (runtime.listAutomations as ReturnType<typeof mock>).mockImplementation(async (workspaceRoot: string) =>
      workspaceRoot === projects[0].workspaceRoot ? [automation] : [],
    );

    const res = await app.request("/api/automations?status=active");
    const body = await res.json() as { automations: Array<Automation & { projectSlug: string; projectName: string }> };

    expect(res.status).toBe(200);
    expect(body.automations).toEqual([
      expect.objectContaining({
        id: automation.id,
        name: "Daily check-in",
        status: "active",
        projectSlug: projects[0].slug,
        projectName: projects[0].name,
      }),
    ]);
  });
});
