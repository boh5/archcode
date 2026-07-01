import { Hono } from "hono";
import type { AgentRuntime, ProjectInfo } from "@archcode/agent-core";
import type { GoalState, GoalStatus } from "@archcode/protocol";
import { BadRequestError } from "../errors";

const GoalStatusSchemaValues = new Set<GoalStatus>([
  "draft",
  "locked",
  "running",
  "verifying",
  "reviewed",
  "completed",
  "failed",
  "escalated",
  "paused",
]);

const ActiveGoalStatuses = new Set<GoalStatus>([
  "locked",
  "running",
  "verifying",
  "reviewed",
  "paused",
]);

type DashboardGoal = GoalState & {
  projectSlug: string;
  projectName: string;
};

export function createDashboardRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/goals", async (c) => {
    const status = parseGoalStatusFilter(c.req.query("status"));
    const goals: DashboardGoal[] = [];

    for (const project of await listProjects(runtime)) {
      try {
        const context = await runtime.contextResolver.resolve(project.workspaceRoot);
        const projectGoals = await context.goalState.listGoals(project.slug);
        goals.push(
          ...projectGoals
            .filter((goal) => matchesGoalStatus(goal, status))
            .map((goal) => withProject(goal, project)),
        );
      } catch {
        // Dashboard aggregation is best-effort: one corrupt project must not
        // prevent other project goals from rendering.
      }
    }

    return c.json({ goals });
  });

  return app;
}

function parseGoalStatusFilter(status: string | undefined): GoalStatus | "active" | undefined {
  if (status === undefined) return undefined;
  if (status === "active") return "active";
  if (!GoalStatusSchemaValues.has(status as GoalStatus)) {
    throw new BadRequestError("status must be active or a valid goal status");
  }
  return status as GoalStatus;
}

function matchesGoalStatus(goal: GoalState, status: GoalStatus | "active" | undefined): boolean {
  if (status === undefined) return true;
  if (status === "active") return ActiveGoalStatuses.has(goal.status);
  return goal.status === status;
}

function withProject(goal: GoalState, project: ProjectInfo): DashboardGoal {
  return {
    ...goal,
    projectSlug: project.slug,
    projectName: project.name,
  };
}

async function listProjects(runtime: AgentRuntime): Promise<ProjectInfo[]> {
  const registry = runtime.projectRegistry as AgentRuntime["projectRegistry"] & {
    listProjects?: () => Promise<ProjectInfo[]>;
  };
  return await (registry.listProjects?.() ?? registry.list());
}
