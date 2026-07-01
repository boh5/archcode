import { Hono } from "hono";
import type { AgentRuntime } from "@archcode/agent-core";
import type { ApprovalPoint, DoneCondition, GoalState, GoalStatus, RetryPolicy } from "@archcode/protocol";
import { z } from "zod/v4";
import { BadRequestError, ServerError } from "../errors";
import { resolveProject } from "../resolve";

const GoalUuidSchema = z.uuid();
const GoalStatusSchema = z.enum([
  "draft",
  "locked",
  "running",
  "verifying",
  "reviewed",
  "completed",
  "failed",
  "escalated",
  "paused",
]) satisfies z.ZodType<GoalStatus>;

const RetryPolicySchema = z.strictObject({
  maxRetries: z.number().int().nonnegative(),
  backoffMs: z.number().int().nonnegative(),
  escalateOnFailure: z.boolean(),
}) satisfies z.ZodType<RetryPolicy>;

const ApprovalPointSchema = z.enum(["after_plan", "before_complete"]) satisfies z.ZodType<ApprovalPoint>;

const DoneConditionSchema = z.custom<DoneCondition>((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { id?: unknown; kind?: unknown; required?: unknown; params?: unknown };
  return typeof candidate.id === "string"
    && candidate.id.trim().length > 0
    && typeof candidate.kind === "string"
    && (candidate.required === undefined || typeof candidate.required === "boolean")
    && candidate.params !== undefined
    && typeof candidate.params === "object"
    && !Array.isArray(candidate.params);
}, "done condition must be an object with id, kind, and params");

const CreateGoalBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  doneConditions: z.array(DoneConditionSchema),
  retryPolicy: RetryPolicySchema,
  approvalPoints: z.array(ApprovalPointSchema),
  reviewerAgent: z.string().trim().min(1),
  author: z.string().trim().min(1),
});

const PatchGoalBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  doneConditions: z.array(DoneConditionSchema).optional(),
  retryPolicy: RetryPolicySchema.optional(),
  approvalPoints: z.array(ApprovalPointSchema).optional(),
  reviewerAgent: z.string().trim().min(1).optional(),
  author: z.string().trim().min(1).optional(),
});

const LockGoalBodySchema = z.strictObject({
  lockedBy: z.string().trim().min(1),
});

const SessionIdsBodySchema = z.strictObject({
  mainSessionId: z.string().trim().min(1).optional(),
  childSessionIds: z.array(z.string().trim().min(1)).optional(),
});

type SessionIdsBody = z.infer<typeof SessionIdsBodySchema>;

export function createGoalsRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/:slug/goals", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const status = c.req.query("status");
    if (status !== undefined && !GoalStatusSchema.safeParse(status).success) {
      throw new BadRequestError("status must be a valid goal status");
    }

    const manager = await goalStateFor(runtime, project.workspaceRoot);
    const goals = (await manager.listGoals(project.slug)).filter((goal) => status === undefined || goal.status === status);
    return c.json({ goals });
  });

  app.post("/:slug/goals", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const body = await readJsonBody(c.req.json(), CreateGoalBodySchema);
    const manager = await goalStateFor(runtime, project.workspaceRoot);

    try {
      const goal = await manager.create(
        project.slug,
        body.title,
        body.author,
        body.doneConditions,
        body.retryPolicy,
        body.approvalPoints,
        body.reviewerAgent,
      );
      return c.json(goal, 201);
    } catch (error) {
      throw mapGoalError(error);
    }
  });

  app.get("/:slug/goals/:goalId", async (c) => {
    const { workspaceRoot } = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));
    const manager = await goalStateFor(runtime, workspaceRoot);

    try {
      return c.json(await manager.read(goalId));
    } catch (error) {
      throw mapGoalError(error);
    }
  });

  app.patch("/:slug/goals/:goalId", async (c) => {
    const { workspaceRoot } = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));
    const body = await readJsonBody(c.req.json(), PatchGoalBodySchema);
    if (Object.keys(body).length === 0) {
      throw new BadRequestError("At least one patch field is required");
    }

    const manager = await goalStateFor(runtime, workspaceRoot);
    try {
      return c.json(await manager.patch(goalId, body));
    } catch (error) {
      throw mapGoalError(error);
    }
  });

  app.post("/:slug/goals/:goalId/lock", async (c) => {
    const { workspaceRoot } = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));
    const body = await readJsonBody(c.req.json(), LockGoalBodySchema);
    const manager = await goalStateFor(runtime, workspaceRoot);

    try {
      return c.json(await manager.lock(goalId, body.lockedBy));
    } catch (error) {
      throw mapGoalError(error);
    }
  });

  app.post("/:slug/goals/:goalId/run", async (c) => {
    const { workspaceRoot } = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));
    const body = await readOptionalSessionIdsBody(c.req.json());
    const manager = await goalStateFor(runtime, workspaceRoot);

    try {
      await manager.transitionStatus(goalId, "running");
      return c.json(await maybeUpdateSessionIds(await manager.read(goalId), body, manager.updateSessionIds.bind(manager)));
    } catch (error) {
      throw mapGoalError(error);
    }
  });

  app.post("/:slug/goals/:goalId/retry", async (c) => {
    const { workspaceRoot } = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));
    const body = await readOptionalSessionIdsBody(c.req.json());
    const manager = await goalStateFor(runtime, workspaceRoot);

    try {
      await manager.incrementRetryCount(goalId);
      await manager.updatePhase(goalId, "plan");
      const retried = await manager.transitionStatus(goalId, "running");
      return c.json(await maybeUpdateSessionIds(retried, body, manager.updateSessionIds.bind(manager)));
    } catch (error) {
      throw mapGoalError(error);
    }
  });

  app.post("/:slug/goals/:goalId/escalate", async (c) => {
    const { workspaceRoot } = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));
    const manager = await goalStateFor(runtime, workspaceRoot);

    try {
      const goal = await manager.read(goalId);
      if (goal.status === "paused" || goal.status === "locked") {
        await manager.transitionStatus(goalId, "running");
      }
      const current = await manager.read(goalId);
      if (current.status !== "failed") {
        await manager.transitionStatus(goalId, "failed");
      }
      return c.json(await manager.transitionStatus(goalId, "escalated"));
    } catch (error) {
      throw mapGoalError(error);
    }
  });

  app.post("/:slug/goals/:goalId/cancel", async (c) => {
    const { workspaceRoot } = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));
    const manager = await goalStateFor(runtime, workspaceRoot);

    try {
      return c.json(await manager.transitionStatus(goalId, "paused"));
    } catch (error) {
      throw mapGoalError(error);
    }
  });

  return app;
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) {
    throw new BadRequestError(`${name} is required`);
  }
  return value;
}

function requiredGoalId(value: string | undefined): string {
  const goalId = requiredParam(value, "goalId");
  if (!GoalUuidSchema.safeParse(goalId).success) {
    throw new BadRequestError("goalId must be a UUID");
  }
  return goalId;
}

async function goalStateFor(runtime: AgentRuntime, workspaceRoot: string) {
  const context = await runtime.contextResolver.resolve(workspaceRoot);
  return context.goalState;
}

async function readJsonBody<Schema extends z.ZodType>(bodyPromise: Promise<unknown>, schema: Schema): Promise<z.infer<Schema>> {
  let body: unknown;
  try {
    body = await bodyPromise;
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestError("Request body is invalid", z.treeifyError(result.error));
  }
  return result.data;
}

async function readOptionalSessionIdsBody(bodyPromise: Promise<unknown>): Promise<SessionIdsBody> {
  try {
    return await readJsonBody(bodyPromise, SessionIdsBodySchema);
  } catch (error) {
    if (error instanceof BadRequestError && error.message === "Request body must be valid JSON") return {};
    throw error;
  }
}

async function maybeUpdateSessionIds(
  goal: GoalState,
  body: SessionIdsBody,
  updateSessionIds: (goalId: string, mainSessionId?: string, childSessionIds?: string[]) => Promise<GoalState>,
): Promise<GoalState> {
  if (body.mainSessionId === undefined && body.childSessionIds === undefined) return goal;
  return await updateSessionIds(goal.id, body.mainSessionId, body.childSessionIds);
}

function mapGoalError(error: unknown): Error {
  if (hasErrorName(error, "GoalNotFoundError")) {
    return new ServerError("SESSION_NOT_FOUND", error.message, 404);
  }
  if (hasErrorName(error, "GoalLockedError") || hasErrorName(error, "GoalStateError")) {
    return new ServerError("BAD_REQUEST", error.message, 409);
  }
  if (hasErrorName(error, "GoalPathError") || hasErrorName(error, "GoalInvalidIdError") || hasErrorName(error, "GoalEmptyConditionsError")) {
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
