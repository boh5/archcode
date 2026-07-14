import { Hono } from "hono";
import { z } from "zod/v4";
import type { AgentRuntime, ProjectInfo } from "@archcode/agent-core";
import type { Automation, GoalState, GoalStatus } from "@archcode/protocol";
import { zValidator } from "../validation";

const DashboardGoalStatusSchema = z.enum([
  "running",
  "reviewing",
  "done",
  "not_done",
  "failed",
  "cancelled",
  "active",
  "terminal",
], { error: "status must be active, terminal, or a valid goal status" });

const DashboardGoalQuerySchema = z.object({
  status: DashboardGoalStatusSchema.optional(),
}).strict();

const DashboardAutomationStatusSchema = z.enum([
  "active",
  "paused",
  "disabled",
], { error: "status must be active or a valid automation status" });

const DashboardAutomationQuerySchema = z.object({
  status: DashboardAutomationStatusSchema.optional(),
}).strict();

const ActiveGoalStatuses = new Set<GoalStatus>([
  "running",
  "reviewing",
  "not_done",
  "failed",
]);

const TerminalGoalStatuses = new Set<GoalStatus>([
  "done",
  "cancelled",
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

type DashboardAutomation = Automation & {
  projectSlug: string;
  projectName: string;
};

export function createDashboardRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/goals", zValidator("query", DashboardGoalQuerySchema), async (c) => {
    const { status } = c.req.valid("query");
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

  app.get("/automations", zValidator("query", DashboardAutomationQuerySchema), async (c) => {
    const { status } = c.req.valid("query");
    const automations: DashboardAutomation[] = [];
    const errors: DashboardProjectError[] = [];

    for (const project of await listProjects(runtime)) {
      try {
        const projectAutomations = await runtime.listAutomations(project.workspaceRoot);
        automations.push(
          ...projectAutomations
            .filter((automation) => matchesAutomationStatus(automation, status))
            .map((automation) => ({
              ...automation,
              projectSlug: project.slug,
              projectName: project.name,
            })),
        );
      } catch (error) {
        errors.push(withProjectError(project, error));
      }
    }

    return c.json({ automations, errors });
  });

  return app;
}

function matchesGoalStatus(goal: GoalState, status: GoalStatus | "active" | "terminal" | undefined): boolean {
  if (status === undefined) return true;
  if (status === "active") return ActiveGoalStatuses.has(goal.status);
  if (status === "terminal") return TerminalGoalStatuses.has(goal.status);
  return goal.status === status;
}

function matchesAutomationStatus(automation: Automation, status: Automation["status"] | undefined): boolean {
  if (status === undefined) return true;
  if (status === "active") return automation.status === "active";
  return automation.status === status;
}

function withProject(goal: GoalState, project: ProjectInfo): DashboardGoal {
  return {
    ...goal,
    projectSlug: project.slug,
    projectName: project.name,
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
  return await runtime.projectRegistry.list();
}
