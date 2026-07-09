import { Hono } from "hono";
import type { AgentRuntime, ProjectInfo } from "@archcode/agent-core";
import type { GoalState, GoalStatus, LoopRunReport, LoopStatus, LoopTemplateId } from "@archcode/protocol";
import { BadRequestError } from "../errors";
import { redactPublicString } from "../redact";

const GoalStatusSchemaValues = new Set<GoalStatus>([
  "draft",
  "running",
  "blocked",
  "reviewing",
  "done",
  "not_done",
  "failed",
  "cancelled",
]);

const ActiveGoalStatuses = new Set<GoalStatus>([
  "draft",
  "running",
  "blocked",
  "reviewing",
  "not_done",
  "failed",
]);

const TerminalGoalStatuses = new Set<GoalStatus>([
  "done",
  "cancelled",
]);

const LoopStatusSchemaValues = new Set<LoopStatus>([
  "active",
  "paused",
  "disabled",
  "error",
]);

type DashboardGoal = GoalState & {
  projectSlug: string;
  projectName: string;
};

type DashboardProjectError = {
  projectSlug: string;
  projectName: string;
  message: string;
};

type DashboardLoopRunSummary = {
  runId: string;
  status: LoopRunReport["status"];
  trigger: LoopRunReport["trigger"];
  startedAt: number;
  endedAt?: number;
  sessionId?: string;
  reason?: string;
  summary?: string;
  error?: string;
};

type DashboardLoop = {
  loopId: string;
  title: string | null;
  status: LoopStatus;
  currentRun?: DashboardLoopRunSummary;
  lastRun?: DashboardLoopRunSummary;
  nextRunAt?: number;
  templateId: LoopTemplateId;
  projectSlug: string;
  projectName: string;
};

export function createDashboardRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/goals", async (c) => {
    const status = parseGoalStatusFilter(c.req.query("status"));
    const goals: DashboardGoal[] = [];
    const errors: DashboardProjectError[] = [];

    for (const project of await listProjects(runtime)) {
      try {
        const context = await runtime.contextResolver.resolve(project.workspaceRoot);
        const projectGoals = await context.goalState.listGoals(project.slug);
        goals.push(
          ...projectGoals
            .filter((goal) => matchesGoalStatus(goal, status))
            .map((goal) => withProject(goal, project)),
        );
      } catch (error) {
        // Dashboard aggregation is best-effort: one corrupt project must not
        // prevent other project goals from rendering.
        errors.push(withProjectError(project, error));
      }
    }

    return c.json({ goals, errors });
  });

  app.get("/loops", async (c) => {
    const status = parseLoopStatusFilter(c.req.query("status"));
    const loops: DashboardLoop[] = [];
    const errors: DashboardProjectError[] = [];

    for (const project of await listProjects(runtime)) {
      try {
        const projectLoops = await runtime.listLoops(project.workspaceRoot);
        loops.push(
          ...projectLoops
            .filter((loop) => matchesLoopStatus(loop, status))
            .map((loop) => ({
              loopId: loop.loopId,
              title: loop.config.title,
              status: loop.status,
              ...(loop.currentRun === undefined ? {} : { currentRun: toDashboardLoopRunSummary(loop.currentRun) }),
              ...(loop.lastRun === undefined ? {} : { lastRun: toDashboardLoopRunSummary(loop.lastRun) }),
              nextRunAt: loop.nextRunAt,
              templateId: loop.config.templateId,
              projectSlug: project.slug,
              projectName: project.name,
            })),
        );
      } catch (error) {
        errors.push(withProjectError(project, error));
      }
    }

    return c.json({ loops, errors });
  });

  return app;
}

function parseGoalStatusFilter(status: string | undefined): GoalStatus | "active" | "terminal" | undefined {
  if (status === undefined) return undefined;
  if (status === "active") return "active";
  if (status === "terminal") return "terminal";
  if (!GoalStatusSchemaValues.has(status as GoalStatus)) {
    throw new BadRequestError("status must be active, terminal, or a valid goal status");
  }
  return status as GoalStatus;
}

function matchesGoalStatus(goal: GoalState, status: GoalStatus | "active" | "terminal" | undefined): boolean {
  if (status === undefined) return true;
  if (status === "active") return ActiveGoalStatuses.has(goal.status);
  if (status === "terminal") return TerminalGoalStatuses.has(goal.status);
  return goal.status === status;
}

function parseLoopStatusFilter(status: string | undefined): LoopStatus | "active" | undefined {
  if (status === undefined) return undefined;
  if (status === "active") return "active";
  if (!LoopStatusSchemaValues.has(status as LoopStatus)) {
    throw new BadRequestError("status must be active or a valid loop status");
  }
  return status as LoopStatus;
}

function matchesLoopStatus(loop: { status: LoopStatus }, status: LoopStatus | "active" | undefined): boolean {
  if (status === undefined) return true;
  if (status === "active") return loop.status === "active";
  return loop.status === status;
}

function withProject(goal: GoalState, project: ProjectInfo): DashboardGoal {
  return {
    ...goal,
    projectSlug: project.slug,
    projectName: project.name,
  };
}

function toDashboardLoopRunSummary(run: LoopRunReport): DashboardLoopRunSummary {
  return {
    runId: run.runId,
    status: run.status,
    trigger: run.trigger,
    startedAt: run.startedAt,
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    ...(run.reason === undefined ? {} : { reason: redactPublicString(run.reason) }),
    ...(run.summary === undefined ? {} : { summary: redactPublicString(run.summary) }),
    ...(run.error === undefined ? {} : { error: redactPublicString(run.error) }),
  };
}

function withProjectError(project: ProjectInfo, error: unknown): DashboardProjectError {
  return {
    projectSlug: project.slug,
    projectName: project.name,
    message: error instanceof Error ? error.message : String(error),
  };
}

async function listProjects(runtime: AgentRuntime): Promise<ProjectInfo[]> {
  const registry = runtime.projectRegistry as AgentRuntime["projectRegistry"] & {
    listProjects?: () => Promise<ProjectInfo[]>;
  };
  return await (registry.listProjects?.() ?? registry.list());
}
