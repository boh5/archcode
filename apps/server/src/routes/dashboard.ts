import { Hono } from "hono";
import { z } from "zod/v4";
import type { AgentRuntime, ProjectInfo } from "@archcode/agent-core";
import type { Automation, SessionGoal, SessionSummary } from "@archcode/protocol";
import { zValidator } from "../validation";

const SessionGoalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "budget_limited",
  "complete",
]);

const DashboardSessionGoalQuerySchema = z.object({
  status: SessionGoalStatusSchema.optional(),
}).strict();

const DashboardAutomationStatusSchema = z.enum([
  "active",
  "paused",
  "disabled",
], { error: "status must be active or a valid automation status" });

const DashboardAutomationQuerySchema = z.object({
  status: DashboardAutomationStatusSchema.optional(),
}).strict();

export type SessionGoalStatus = z.infer<typeof SessionGoalStatusSchema>;

/**
 * Dashboard is a projection over root Sessions. It deliberately has no Goal
 * resource ID or backing store: Session.goal remains the sole owner.
 */
export type DashboardSessionGoal = {
  sessionId: string;
  sessionTitle: string | null;
  updatedAt: number;
  projectSlug: string;
  projectName: string;
  goal: DashboardSessionGoalView;
};

export type DashboardSessionGoalView = {
  objective: string;
  status: SessionGoalStatus;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  latestReason?: string;
};

type DashboardProjectError = {
  projectSlug: string;
  projectName: string;
  message: string;
};

type DashboardAutomation = Automation & {
  projectName: string;
};

export function createDashboardRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/session-goals", zValidator("query", DashboardSessionGoalQuerySchema), async (c) => {
    const { status } = c.req.valid("query");
    const sessionGoals: DashboardSessionGoal[] = [];
    const errors: DashboardProjectError[] = [];

    for (const project of await listProjects(runtime)) {
      try {
        const sessions = await runtime.listSessions(project.workspaceRoot);
        sessionGoals.push(
          ...sessions
            .map((session) => toDashboardSessionGoal(session, project))
            .filter((entry): entry is DashboardSessionGoal => entry !== undefined)
            .filter((entry) => status === undefined || entry.goal.status === status),
        );
      } catch (error) {
        // Dashboard aggregation is best-effort: one corrupt project must not
        // prevent other project Sessions from rendering.
        errors.push(withProjectError(project, error));
      }
    }

    return c.json({ sessionGoals, errors });
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

function toDashboardSessionGoal(session: SessionSummary, project: ProjectInfo): DashboardSessionGoal | undefined {
  if (session.parentSessionId !== undefined || session.goal === undefined) return undefined;
  return {
    sessionId: session.sessionId,
    sessionTitle: session.title,
    updatedAt: session.updatedAt,
    projectSlug: project.slug,
    projectName: project.name,
    goal: toDashboardGoalView(session.goal),
  };
}

function toDashboardGoalView(goal: SessionGoal): DashboardSessionGoalView {
  return {
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.usage.tokens.totalTokens,
    timeUsedSeconds: Math.round(goal.usage.executionTimeMs / 1_000),
    latestReason: goal.blockedReason ?? goal.lastReviewReceipt?.summary ?? goal.lastEvaluator?.reason,
  };
}

function matchesAutomationStatus(automation: Automation, status: Automation["status"] | undefined): boolean {
  if (status === undefined) return true;
  if (status === "active") return automation.status === "active";
  return automation.status === status;
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
