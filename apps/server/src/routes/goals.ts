import { Hono } from "hono";
import type { GoalState, GoalStatus } from "@archcode/protocol";
import type { AgentRuntime } from "@archcode/agent-core";
import { z } from "zod/v4";
import { BadRequestError, ConcurrentSessionLimitHttpError, ServerError } from "../errors";
import { resolveProject } from "../resolve";

const GoalUuidSchema = z.uuid();
const GoalStatusSchema = z.enum([
  "draft",
  "running",
  "blocked",
  "reviewing",
  "done",
  "not_done",
  "failed",
  "cancelled",
]) satisfies z.ZodType<GoalStatus>;

const GoalTitleSchema = z.string().trim().min(1).max(160);
const GoalNaturalLanguageSchema = z.string().trim().min(1).max(8_000);

const CreateGoalBodySchema = z.strictObject({
  title: GoalTitleSchema,
  objective: GoalNaturalLanguageSchema,
  acceptanceCriteria: GoalNaturalLanguageSchema,
});

const PatchGoalBodySchema = z.strictObject({
  title: GoalTitleSchema.optional(),
  objective: GoalNaturalLanguageSchema.optional(),
  acceptanceCriteria: GoalNaturalLanguageSchema.optional(),
});

const SessionIdsBodySchema = z.strictObject({
  mainSessionId: z.string().trim().min(1).optional(),
  childSessionIds: z.array(z.string().trim().min(1)).optional(),
});

type SessionIdsBody = z.infer<typeof SessionIdsBodySchema>;
type GoalPatchBody = z.infer<typeof PatchGoalBodySchema>;

interface SimplifiedGoalStateManager {
  listGoals(projectId?: string): Promise<GoalState[]>;
  create(projectId: string, title: string, objective: string, acceptanceCriteria: string): Promise<GoalState>;
  read(goalId: string): Promise<GoalState>;
  patchDraft(goalId: string, updates: GoalPatchBody): Promise<GoalState>;
  start(goalId: string): Promise<GoalState>;
  retry(goalId: string): Promise<GoalState>;
  cancel(goalId: string, reason?: string): Promise<GoalState>;
  setMainSession(goalId: string, mainSessionId: string): Promise<GoalState>;
  addChildSession(goalId: string, childSessionId: string): Promise<GoalState>;
  fail?(goalId: string, error: { name: string; message: string; at?: string }): Promise<GoalState>;
}

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
    const goals = (await manager.listGoals(project.slug))
      .filter((goal) => status === undefined || goal.status === status)
      .map(toPublicGoal);
    return c.json({ goals });
  });

  app.post("/:slug/goals", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const body = await readJsonBody(c.req.json(), CreateGoalBodySchema);
    const manager = await goalStateFor(runtime, project.workspaceRoot);

    try {
      const goal = await manager.create(project.slug, body.title, body.objective, body.acceptanceCriteria);
      return c.json(toPublicGoal(goal), 201);
    } catch (error) {
      throw mapGoalError(error);
    }
  });

  app.get("/:slug/goals/:goalId", async (c) => {
    const { workspaceRoot } = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));
    const manager = await goalStateFor(runtime, workspaceRoot);

    try {
      return c.json(toPublicGoal(await manager.read(goalId)));
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
      return c.json(toPublicGoal(await manager.patchDraft(goalId, body)));
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
        const updated = await reserveGoalSession(runtime, manager, project.workspaceRoot, goal, body);
        if (updated.mainSessionId !== undefined && runtime.isSessionExecutionRunning(project.workspaceRoot, updated.mainSessionId)) {
          return updated;
        }

        const running = updated.status === "running" ? updated : await manager.start(goalId);
        const withSessions = await ensureReservedSessions(manager, running, updated.mainSessionId, updated.childSessionIds);
        if (withSessions.mainSessionId === undefined) {
          throw new ServerError("BAD_REQUEST", `Goal ${goal.id} could not reserve a main session`, 409);
        }

        try {
          runtime.startSessionExecution({
            slug: project.slug,
            workspaceRoot: project.workspaceRoot,
            sessionId: withSessions.mainSessionId,
            userMessage: buildGoalRunUserMessage(withSessions),
          });
        } catch (error) {
          if (hasErrorName(error, "AgentRunningError")) return withSessions;
          await markGoalRunBootstrapFailure(manager, goalId, error);
          throw error;
        }
        return withSessions;
      });
      return c.json(toPublicGoal(reserved));
    } catch (error) {
      throw mapExecutionOrGoalError(error);
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
        assertGoalCanRetry(goal);

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

        const retried = goal.status === "running" ? goal : await manager.retry(goalId);
        const withSessions = await ensureReservedSessions(manager, retried, mainSessionId, body.childSessionIds);
        if (runtime.isSessionExecutionRunning(project.workspaceRoot, mainSessionId)) return withSessions;

        try {
          runtime.startSessionExecution({
            slug: project.slug,
            workspaceRoot: project.workspaceRoot,
            sessionId: mainSessionId,
            userMessage: buildGoalRetryUserMessage(withSessions),
          });
        } catch (error) {
          if (hasErrorName(error, "AgentRunningError")) return withSessions;
          await markGoalRunBootstrapFailure(manager, goalId, error);
          throw error;
        }
        return withSessions;
      });
      return c.json(toPublicGoal(reserved));
    } catch (error) {
      throw mapExecutionOrGoalError(error);
    }
  });

  app.post("/:slug/goals/:goalId/cancel", async (c) => {
    const { workspaceRoot } = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const goalId = requiredGoalId(c.req.param("goalId"));
    const manager = await goalStateFor(runtime, workspaceRoot);

    try {
      return c.json(toPublicGoal(await manager.cancel(goalId)));
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

function buildGoalRunUserMessage(goal: GoalState): string {
  return [
    "Start this ArchCode Goal.",
    `Goal ID: ${goal.id}`,
    "Objective:",
    goal.objective,
    "Acceptance criteria:",
    goal.acceptanceCriteria,
    "Your first action must be calling goal_manage with action:\"start\" and this Goal ID before doing implementation work.",
  ].join("\n");
}

function buildGoalRetryUserMessage(goal: GoalState): string {
  return [
    "Retry this ArchCode Goal.",
    `Goal ID: ${goal.id}`,
    "Objective:",
    goal.objective,
    "Acceptance criteria:",
    goal.acceptanceCriteria,
    "Your first action must be calling goal_manage with action:\"retry\" and this Goal ID before doing implementation work.",
  ].join("\n");
}

function assertGoalCanRun(goal: GoalState): void {
  if (goal.status === "draft" || goal.status === "running") return;
  throw new ServerError("BAD_REQUEST", `Invalid goal state for ${goal.id}`, 409);
}

function assertGoalCanRetry(goal: GoalState): void {
  if (goal.status === "not_done" || goal.status === "failed" || goal.status === "running") return;
  throw new ServerError("BAD_REQUEST", `Invalid goal state for ${goal.id}`, 409);
}

async function reserveGoalSession(
  runtime: AgentRuntime,
  manager: SimplifiedGoalStateManager,
  workspaceRoot: string,
  goal: GoalState,
  body: SessionIdsBody,
): Promise<GoalState> {
  if (goal.mainSessionId !== undefined && body.mainSessionId !== undefined && goal.mainSessionId !== body.mainSessionId) {
    throw new ServerError("BAD_REQUEST", `Goal ${goal.id} is already reserved for session ${goal.mainSessionId}`, 409);
  }

  const mainSessionId = goal.mainSessionId ?? body.mainSessionId ?? (await runtime.createSession(workspaceRoot, {
    goalId: goal.id,
    sessionRole: "main",
    title: goal.title,
  })).sessionId;

  return await ensureReservedSessions(manager, goal, mainSessionId, body.childSessionIds);
}

async function ensureReservedSessions(
  manager: SimplifiedGoalStateManager,
  goal: GoalState,
  mainSessionId: string | undefined,
  childSessionIds: string[] | undefined,
): Promise<GoalState> {
  let current = goal;
  if (mainSessionId !== undefined && current.mainSessionId !== mainSessionId) {
    current = await manager.setMainSession(current.id, mainSessionId);
  }
  if (childSessionIds !== undefined) {
    for (const childSessionId of childSessionIds) {
      if (!current.childSessionIds.includes(childSessionId)) {
        current = await manager.addChildSession(current.id, childSessionId);
      }
    }
  }
  return current;
}

async function goalStateFor(runtime: AgentRuntime, workspaceRoot: string): Promise<SimplifiedGoalStateManager> {
  const context = await runtime.contextResolver.resolve(workspaceRoot);
  return context.goalState as unknown as SimplifiedGoalStateManager;
}

async function markGoalRunBootstrapFailure(
  manager: SimplifiedGoalStateManager,
  goalId: string,
  error: unknown,
): Promise<void> {
  if (manager.fail === undefined) return;
  try {
    await manager.fail(goalId, {
      name: error instanceof Error ? error.name : "Error",
      message: `Goal run bootstrap could not start: ${errorMessage(error)}`,
      at: new Date().toISOString(),
    });
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

function toPublicGoal(goal: GoalState): GoalState {
  return {
    id: goal.id,
    projectId: goal.projectId,
    title: goal.title,
    objective: goal.objective,
    acceptanceCriteria: goal.acceptanceCriteria,
    status: goal.status,
    ...(goal.blocker === undefined ? {} : { blocker: goal.blocker }),
    attempt: goal.attempt,
    ...(goal.lastFailureSummary === undefined ? {} : { lastFailureSummary: goal.lastFailureSummary }),
    ...(goal.budget === undefined ? {} : { budget: goal.budget }),
    pendingHitlIds: goal.pendingHitlIds,
    approvalRefs: goal.approvalRefs,
    ...(goal.mainSessionId === undefined ? {} : { mainSessionId: goal.mainSessionId }),
    childSessionIds: goal.childSessionIds,
    ...(goal.loopId === undefined ? {} : { loopId: goal.loopId }),
    ...(goal.review === undefined ? {} : { review: goal.review }),
    ...(goal.finalSummary === undefined ? {} : { finalSummary: goal.finalSummary }),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    ...(goal.startedAt === undefined ? {} : { startedAt: goal.startedAt }),
    ...(goal.completedAt === undefined ? {} : { completedAt: goal.completedAt }),
    ...(goal.cancelledAt === undefined ? {} : { cancelledAt: goal.cancelledAt }),
    ...(goal.lastError === undefined ? {} : { lastError: goal.lastError }),
  };
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
  if (hasErrorName(error, "GoalLockedError") || hasErrorName(error, "GoalStateError")) {
    return new ServerError("BAD_REQUEST", error.message, 409);
  }
  if (hasErrorName(error, "GoalPathError") || hasErrorName(error, "GoalInvalidIdError") || hasErrorName(error, "GoalSchemaError")) {
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
