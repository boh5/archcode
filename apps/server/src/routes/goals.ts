import { Hono } from "hono";
import type { GoalState, GoalStatus } from "@archcode/protocol";
import type { AgentRuntime } from "@archcode/agent-core";
import { z } from "zod/v4";

import { BadRequestError, ConcurrentSessionLimitHttpError, ServerError } from "../errors";
import { resolveProject } from "../resolve";

const GoalUuidSchema = z.uuid();
const GoalStatusSchema = z.enum([
  "running",
  "blocked",
  "reviewing",
  "done",
  "not_done",
  "failed",
  "cancelled",
]) satisfies z.ZodType<GoalStatus>;

export function createGoalsRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/:slug/goals", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const status = c.req.query("status");
    if (status !== undefined && !GoalStatusSchema.safeParse(status).success) {
      throw new BadRequestError("status must be a valid goal status");
    }

    const goals = (await (await runtime.contextResolver.resolve(project.workspaceRoot)).goalState.listGoals(project.slug))
      .filter((goal) => status === undefined || goal.status === status)
      .map(toPublicGoal);
    return c.json({ goals });
  });

  app.get("/:slug/goals/:goalId", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));

    try {
      const goal = await (await runtime.contextResolver.resolve(project.workspaceRoot)).goalState.read(goalId);
      return c.json(toPublicGoal(goal));
    } catch (error) {
      throw mapGoalError(error);
    }
  });

  app.post("/:slug/goals/:goalId/retry", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));
    await requireEmptyRequestBody(c.req.text());
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);

    try {
      const current = await context.goalState.read(goalId);
      if (current.status !== "failed" && current.status !== "not_done") {
        throw new ServerError("BAD_REQUEST", `Invalid goal state for ${goalId}`, 409);
      }
      if (runtime.getSessionFamilyActivity(project.workspaceRoot, current.mainSessionId) !== "idle") {
        throw new ServerError("BAD_REQUEST", `Goal ${goalId} main Session is active`, 409);
      }

      const retried = await context.goalRunner.retry(goalId);
      try {
        runtime.startSessionExecution({
          slug: project.slug,
          workspaceRoot: project.workspaceRoot,
          sessionId: retried.mainSessionId,
          userMessage: buildGoalRetryUserMessage(retried),
        });
      } catch (error) {
        if (!hasErrorName(error, "AgentRunningError")) {
          await context.goalRunner.fail(goalId, new Error(`Goal retry could not start: ${errorMessage(error)}`));
          throw error;
        }
      }
      return c.json(toPublicGoal(retried));
    } catch (error) {
      throw mapExecutionOrGoalError(error);
    }
  });

  app.post("/:slug/goals/:goalId/cancel", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));

    try {
      return c.json(toPublicGoal(await runtime.cancelGoal(project.workspaceRoot, goalId, { source: "http" })));
    } catch (error) {
      throw mapExecutionOrGoalError(error);
    }
  });

  return app;
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) throw new BadRequestError(`${name} is required`);
  return value;
}

function requiredGoalId(value: string | undefined): string {
  const goalId = requiredParam(value, "goalId");
  if (!GoalUuidSchema.safeParse(goalId).success) throw new BadRequestError("goalId must be a UUID");
  return goalId;
}

async function requireEmptyRequestBody(bodyPromise: Promise<string>): Promise<void> {
  if ((await bodyPromise).trim().length !== 0) {
    throw new BadRequestError("Retry requests must not include a request body");
  }
}

function buildGoalRetryUserMessage(goal: GoalState): string {
  return [
    "Retry this ArchCode Goal.",
    `Goal ID: ${goal.id}`,
    "Objective:",
    goal.objective,
    "Acceptance criteria:",
    goal.acceptanceCriteria,
    "Runtime has already claimed this retry for the current Goal Lead Session.",
    "Continue with the required fixes, delegate as needed, and hand off to Reviewer when ready.",
  ].join("\n");
}

function toPublicGoal(goal: GoalState): GoalState {
  return { ...goal };
}

function mapExecutionOrGoalError(error: unknown): Error {
  if (isConcurrentSessionLimitError(error)) {
    return new ConcurrentSessionLimitHttpError(error.current, error.max);
  }
  return mapGoalError(error);
}

function mapGoalError(error: unknown): Error {
  if (hasErrorName(error, "GoalNotFoundError")) {
    return new ServerError("SESSION_NOT_FOUND", error.message, 404);
  }
  if (
    hasErrorName(error, "GoalStateError")
    || hasErrorName(error, "GoalTransitionError")
    || hasErrorName(error, "GoalReviewerAuthorizationError")
    || hasErrorName(error, "GoalReviewFinalizationError")
    || hasErrorName(error, "GoalWorkspaceError")
    || hasErrorName(error, "GoalRunnerError")
    || hasErrorName(error, "GoalCancellationError")
    || hasErrorName(error, "GoalCancellationInProgressError")
    || hasErrorName(error, "SessionFamilyStopConflictError")
    || hasErrorName(error, "SessionFamilyStopInProgressError")
    || hasErrorName(error, "WorktreeServiceError")
  ) {
    return new ServerError("BAD_REQUEST", error.message, 409);
  }
  if (hasErrorName(error, "GoalPathError") || hasErrorName(error, "GoalInvalidIdError")) {
    return new BadRequestError(error.message);
  }
  if (error instanceof z.ZodError) {
    return new BadRequestError("Request body is invalid", z.treeifyError(error));
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function hasErrorName(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name;
}

function isConcurrentSessionLimitError(error: unknown): error is Error & { current: number; max: number } {
  return hasErrorName(error, "ConcurrentSessionLimitError")
    && typeof (error as { current?: unknown }).current === "number"
    && typeof (error as { max?: unknown }).max === "number";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}
