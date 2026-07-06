import { Hono } from "hono";
import { AgentRunningError, ConcurrentSessionLimitError, DoneConditionSchema, GoalArtifactNameSchema, type AgentRuntime } from "@archcode/agent-core";
import type { ApprovalPoint, GoalArtifactName, GoalState, GoalStatus, RetryPolicy } from "@archcode/protocol";
import { z } from "zod/v4";
import { BadRequestError, ConcurrentSessionLimitHttpError, ServerError } from "../errors";
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

const goalRunReservationLocks = new Map<string, Promise<void>>();

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

  app.get("/:slug/goals/:goalId/artifacts", async (c) => {
    const { workspaceRoot } = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));
    const context = await goalContextFor(runtime, workspaceRoot);

    try {
      await context.goalState.read(goalId);
      return c.json({ artifacts: await context.goalArtifacts.listArtifacts(goalId) });
    } catch (error) {
      throw mapGoalError(error);
    }
  });

  app.get("/:slug/goals/:goalId/artifacts/:artifactName", async (c) => {
    const { workspaceRoot } = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));
    const artifactName = requiredArtifactName(c.req.param("artifactName"));
    const context = await goalContextFor(runtime, workspaceRoot);

    try {
      await context.goalState.read(goalId);
      const content = await context.goalArtifacts.readArtifact(goalId, artifactName);
      if (content === null) {
        throw new ServerError("SESSION_NOT_FOUND", `Goal artifact not found: ${artifactName}`, 404);
      }
      const artifact = (await context.goalArtifacts.listArtifacts(goalId))
        .find((candidate) => candidate.name === artifactName);
      return c.json({ artifact, content });
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
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));
    const body = await readOptionalSessionIdsBody(c.req.text());
    const manager = await goalStateFor(runtime, project.workspaceRoot);

    try {
      const reserved = await withGoalRunReservationLock(project.workspaceRoot, goalId, async () => {
        const goal = await manager.read(goalId);
        assertGoalCanRun(goal);
        if (goal.status === "running") return goal;
        if (goal.mainSessionId !== undefined && body.mainSessionId !== undefined && goal.mainSessionId !== body.mainSessionId) {
          throw new ServerError("BAD_REQUEST", `Goal ${goal.id} is already reserved for session ${goal.mainSessionId}`, 409);
        }

        const mainSessionId = goal.mainSessionId ?? body.mainSessionId ?? (await runtime.createSession(project.workspaceRoot, {
          goalId,
          sessionRole: "main",
          title: goal.title,
        })).sessionId;

        const updated = await manager.updateSessionIds(goalId, mainSessionId, body.childSessionIds);
        if (runtime.isSessionExecutionRunning(project.workspaceRoot, mainSessionId)) return updated;

        try {
          runtime.startSessionExecution({
            slug: project.slug,
            workspaceRoot: project.workspaceRoot,
            sessionId: mainSessionId,
            userMessage: buildGoalRunUserMessage(updated),
          });
        } catch (error) {
          if (error instanceof AgentRunningError) return updated;
          await markGoalRunBootstrapFailure(manager, goalId, error);
          throw error;
        }
        return updated;
      });
      return c.json(reserved);
    } catch (error) {
      if (error instanceof ConcurrentSessionLimitError) {
        throw new ConcurrentSessionLimitHttpError(error.current, error.max);
      }
      throw mapGoalError(error);
    }
  });

  app.post("/:slug/goals/:goalId/retry", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));
    const body = await readOptionalSessionIdsBody(c.req.text());
    const manager = await goalStateFor(runtime, project.workspaceRoot);

    try {
      const reserved = await withGoalRunReservationLock(project.workspaceRoot, goalId, async () => {
        const goal = await manager.read(goalId);
        if (goal.status !== "failed") {
          throw new ServerError("BAD_REQUEST", `Invalid goal state for ${goal.id}`, 409);
        }

        const activeReservedSessionId = goal.mainSessionId && runtime.isSessionExecutionRunning(project.workspaceRoot, goal.mainSessionId)
          ? goal.mainSessionId
          : undefined;
        if (activeReservedSessionId !== undefined && body.mainSessionId !== undefined && body.mainSessionId !== activeReservedSessionId) {
          throw new ServerError("BAD_REQUEST", `Goal ${goal.id} is already reserved for session ${activeReservedSessionId}`, 409);
        }

        const mainSessionId = activeReservedSessionId ?? body.mainSessionId ?? (await runtime.createSession(project.workspaceRoot, {
          goalId,
          sessionRole: "main",
          title: goal.title,
        })).sessionId;
        const updated = await manager.updateSessionIds(goalId, mainSessionId, body.childSessionIds);
        if (runtime.isSessionExecutionRunning(project.workspaceRoot, mainSessionId)) return updated;

        try {
          runtime.startSessionExecution({
            slug: project.slug,
            workspaceRoot: project.workspaceRoot,
            sessionId: mainSessionId,
            userMessage: buildGoalRetryUserMessage(updated),
          });
        } catch (error) {
          if (error instanceof AgentRunningError) return updated;
          await markGoalRunBootstrapFailure(manager, goalId, error);
          throw error;
        }
        return updated;
      });
      return c.json(reserved);
    } catch (error) {
      if (error instanceof ConcurrentSessionLimitError) {
        throw new ConcurrentSessionLimitHttpError(error.current, error.max);
      }
      throw mapGoalError(error);
    }
  });

  app.post("/:slug/goals/:goalId/escalate", async (c) => {
    const { workspaceRoot } = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));
    const manager = await goalStateFor(runtime, workspaceRoot);

    try {
      const goal = await manager.read(goalId);
      if (goal.status !== "failed") {
        throw new ServerError("BAD_REQUEST", `Invalid goal state for ${goal.id}`, 409);
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

function requiredArtifactName(value: string | undefined): GoalArtifactName {
  const artifactName = requiredParam(value, "artifactName");
  const parsed = GoalArtifactNameSchema.safeParse(artifactName);
  if (!parsed.success) {
    throw new BadRequestError("artifactName must be a canonical Goal artifact name");
  }
  return parsed.data;
}

function buildGoalRunUserMessage(goal: GoalState): string {
  return [
    "Bootstrap an ArchCode Goal run.",
    `Goal ID: ${goal.id}`,
    `Goal title JSON: ${JSON.stringify(goal.title)}`,
    "Your first action must be calling goal_manage with action:\"start\" and this Goal ID. Do not edit files, delegate, advance phases, or record Done evidence until goal_manage action:\"start\" succeeds.",
    "After goal_manage action:\"start\" succeeds, load the Goal state, follow the Goal operating loop, keep Done Conditions locked, use Plan/Build/Reviewer delegation, advance phases with goal_manage.action=\"advance_phase\", record Reviewer evidence with goal_evidence action:\"check_done\", and report progress.",
  ].join("\n");
}

function buildGoalRetryUserMessage(goal: GoalState): string {
  return [
    "Bootstrap an ArchCode Goal retry.",
    `Goal ID: ${goal.id}`,
    `Goal title JSON: ${JSON.stringify(goal.title)}`,
    "Your first action must be calling goal_manage with action:\"retry\" and this Goal ID. Do not edit files, delegate, advance phases, or record Done evidence until goal_manage action:\"retry\" succeeds.",
    "After goal_manage action:\"retry\" succeeds, load the Goal state, follow the Goal operating loop from the plan phase, keep Done Conditions locked, use Plan/Build/Reviewer delegation, advance phases with goal_manage.action=\"advance_phase\", record Reviewer evidence with goal_evidence action:\"check_done\", and report progress.",
  ].join("\n");
}

function assertGoalCanRun(goal: GoalState): void {
  if (goal.status === "locked" || goal.status === "paused" || goal.status === "running") return;
  throw new ServerError("BAD_REQUEST", `Invalid goal state for ${goal.id}`, 409);
}

async function goalStateFor(runtime: AgentRuntime, workspaceRoot: string) {
  return (await goalContextFor(runtime, workspaceRoot)).goalState;
}

async function goalContextFor(runtime: AgentRuntime, workspaceRoot: string) {
  return await runtime.contextResolver.resolve(workspaceRoot);
}

async function markGoalRunBootstrapFailure(
  manager: Awaited<ReturnType<typeof goalStateFor>>,
  goalId: string,
  error: unknown,
): Promise<void> {
  const message = `Goal run bootstrap could not start: ${errorMessage(error)}`;
  try {
    await manager.updateLastError(goalId, message);
  } catch {
    // Best-effort annotation: preserve the original execution-start error.
  }
}

async function withGoalRunReservationLock<T>(workspaceRoot: string, goalId: string, action: () => Promise<T>): Promise<T> {
  const key = `${workspaceRoot}:${goalId}`;
  const previous = goalRunReservationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  goalRunReservationLocks.set(key, previous.then(() => current, () => current));

  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (goalRunReservationLocks.get(key) === current) {
      goalRunReservationLocks.delete(key);
    }
  }
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

async function readOptionalSessionIdsBody(bodyPromise: Promise<string>): Promise<SessionIdsBody> {
  const text = await bodyPromise;
  if (text.trim().length === 0) return {};

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }

  const result = SessionIdsBodySchema.safeParse(body);
  if (!result.success) throw new BadRequestError("Request body is invalid", z.treeifyError(result.error));
  return result.data;
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
  if (hasErrorName(error, "GoalArtifactNameError") || hasErrorName(error, "GoalArtifactPathError")) {
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}
