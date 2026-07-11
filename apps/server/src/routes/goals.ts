import { Hono } from "hono";
import type { GoalState, GoalStatus } from "@archcode/protocol";
import {
  GoalWorkspaceService,
  goalExecutionStatusEligibility,
  withGoalExecutionClaimLock,
  type AgentRuntime,
  type GoalWorkspaceStateManager,
} from "@archcode/agent-core";
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

const GoalNaturalLanguageSchema = z.string().trim().min(1).max(8_000);

const CreateGoalBodySchema = z.strictObject({
  objective: GoalNaturalLanguageSchema,
  acceptanceCriteria: GoalNaturalLanguageSchema,
  useWorktree: z.boolean().optional(),
});

const PatchGoalBodySchema = z.strictObject({
  objective: GoalNaturalLanguageSchema.optional(),
  acceptanceCriteria: GoalNaturalLanguageSchema.optional(),
  useWorktree: z.boolean().optional(),
});

const SessionIdSchema = z.uuid();

const SessionIdsBodySchema = z.strictObject({
  mainSessionId: SessionIdSchema.optional(),
  childSessionIds: z.array(SessionIdSchema).max(500).optional(),
});

type SessionIdsBody = z.infer<typeof SessionIdsBodySchema>;
type GoalPatchBody = z.infer<typeof PatchGoalBodySchema>;

interface GoalStateManagerForRoute {
  listGoals(projectId?: string): Promise<GoalState[]>;
  create(input: {
    readonly projectId: string;
    readonly title?: string | null;
    readonly objective: string;
    readonly acceptanceCriteria: string;
    readonly useWorktree?: boolean;
  }): Promise<GoalState>;
  read(goalId: string): Promise<GoalState>;
  patchDraft(goalId: string, updates: GoalPatchBody): Promise<GoalState>;
  start(goalId: string, input?: { readonly mainSessionId?: string }): Promise<GoalState>;
  retry(goalId: string, input?: { readonly mainSessionId?: string }): Promise<GoalState>;
  cancel(goalId: string, reason?: string): Promise<GoalState>;
  setMainSession(goalId: string, mainSessionId: string): Promise<GoalState>;
  addChildSession(goalId: string, childSessionId: string): Promise<GoalState>;
  setWorktree: GoalWorkspaceStateManager["setWorktree"];
  fail?(goalId: string, error: Error | string): Promise<GoalState>;
}

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
      const goal = await manager.create({
        projectId: project.slug,
        objective: body.objective,
        acceptanceCriteria: body.acceptanceCriteria,
        ...(body.useWorktree === undefined ? {} : { useWorktree: body.useWorktree }),
      });
      runtime.queueGoalTitleGeneration?.(project.workspaceRoot, goal.id);
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
      return c.json(toPublicGoal(await withGoalExecutionClaimLock(goalId, () => manager.patchDraft(goalId, body))));
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
      const reserved = await withGoalExecutionClaimLock(goalId, async () => {
        let goal = await manager.read(goalId);
        assertHttpGoalOwnership(goal);
        assertGoalCanRun(goal);
        await validateGoalSessionIdentities(runtime, project.workspaceRoot, goal, body);
        if (goal.status === "running") {
          const runningSessionId = requireRunningMainSession(goal, body.mainSessionId);
          if (await isSessionFamilyActive(runtime, project.workspaceRoot, runningSessionId)) {
            const expectedCwd = goalExecutionCwdFromState(goal, project.workspaceRoot);
            await validateProvidedSessions(runtime, project.workspaceRoot, goal, body, expectedCwd);
            await assertSessionAssignable(runtime, project.workspaceRoot, goal, runningSessionId, "main", expectedCwd);
            return goal;
          }
        }
        await assertNoActiveGoalSessions(runtime, project.workspaceRoot, goal, body);
        const prepared = await prepareGoalWorkspace(manager, project.workspaceRoot, goal);
        goal = prepared.goal;
        await validateProvidedSessions(runtime, project.workspaceRoot, goal, body, prepared.cwd);
        const selectedExistingMainSessionId = goal.mainSessionId ?? body.mainSessionId;
        if (selectedExistingMainSessionId !== undefined) {
          await assertSessionAssignable(runtime, project.workspaceRoot, goal, selectedExistingMainSessionId, "main", prepared.cwd);
        }
        await assertNoActiveGoalSessions(runtime, project.workspaceRoot, goal, body);
        const updated = await reserveGoalSession(runtime, manager, project.workspaceRoot, goal, body, prepared.cwd);

        const running = updated.status === "running" ? updated : await manager.start(goalId, { mainSessionId: updated.mainSessionId });
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
          await markGoalRunStartFailure(manager, goalId, error);
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
      const reserved = await withGoalExecutionClaimLock(goalId, async () => {
        let goal = await manager.read(goalId);
        assertHttpGoalOwnership(goal);
        assertGoalCanRetry(goal);
        await validateGoalSessionIdentities(runtime, project.workspaceRoot, goal, body);
        if (goal.status === "running") {
          const runningSessionId = requireRunningMainSession(goal, body.mainSessionId);
          if (!await isSessionFamilyActive(runtime, project.workspaceRoot, runningSessionId)) {
            throw new ServerError(
              "BAD_REQUEST",
              `Running Goal ${goal.id} can retry only through its active main Session`,
              409,
            );
          }
          const expectedCwd = goalExecutionCwdFromState(goal, project.workspaceRoot);
          await validateProvidedSessions(runtime, project.workspaceRoot, goal, body, expectedCwd);
          await assertSessionAssignable(runtime, project.workspaceRoot, goal, runningSessionId, "main", expectedCwd);
          return goal;
        }
        await assertNoActiveGoalSessions(runtime, project.workspaceRoot, goal, body);
        const prepared = await prepareGoalWorkspace(manager, project.workspaceRoot, goal);
        goal = prepared.goal;
        await validateProvidedSessions(runtime, project.workspaceRoot, goal, body, prepared.cwd);
        await assertNoActiveGoalSessions(runtime, project.workspaceRoot, goal, body);

        const mainSessionId = body.mainSessionId ?? (await runtime.createSession(project.workspaceRoot, {
          goalId,
          sessionRole: "main",
          cwd: prepared.cwd,
        })).sessionId;

        const retried = goal.status === "running" ? goal : await manager.retry(goalId, { mainSessionId });
        const withSessions = await ensureReservedSessions(manager, retried, mainSessionId, body.childSessionIds);
        if (await isSessionFamilyActive(runtime, project.workspaceRoot, mainSessionId)) return withSessions;

        try {
          runtime.startSessionExecution({
            slug: project.slug,
            workspaceRoot: project.workspaceRoot,
            sessionId: mainSessionId,
            userMessage: buildGoalRetryUserMessage(withSessions),
          });
        } catch (error) {
          if (hasErrorName(error, "AgentRunningError")) return withSessions;
          await markGoalRunStartFailure(manager, goalId, error);
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
      return c.json(toPublicGoal(await runtime.cancelGoal(workspaceRoot, goalId, { source: "http" })));
    } catch (error) {
      throw mapExecutionOrGoalError(error);
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
    "Runtime has already started and claimed this Goal for the current main session.",
    "Do not call goal_manage.start again; continue with the Goal work, delegate as needed, and hand off to Reviewer when ready.",
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
    "Runtime has already started and claimed this retry for the current main session.",
    "Do not call goal_manage.retry again; continue with the required fixes, delegate as needed, and hand off to Reviewer when ready.",
  ].join("\n");
}

function assertGoalCanRun(goal: GoalState): void {
  if (goalExecutionStatusEligibility("start", goal.status) !== "reject") return;
  throw new ServerError("BAD_REQUEST", `Invalid goal state for ${goal.id}`, 409);
}

function assertHttpGoalOwnership(goal: GoalState): void {
  if (goal.loopId === undefined) return;
  throw new ServerError(
    "BAD_REQUEST",
    `Goal ${goal.id} is owned by Loop ${goal.loopId} and must be resumed by its owning Loop`,
    409,
  );
}

function assertGoalCanRetry(goal: GoalState): void {
  if (goalExecutionStatusEligibility("retry", goal.status) !== "reject") return;
  throw new ServerError("BAD_REQUEST", `Invalid goal state for ${goal.id}`, 409);
}

function requireRunningMainSession(goal: GoalState, requestedMainSessionId: string | undefined): string {
  if (goal.mainSessionId === undefined) {
    throw new ServerError("BAD_REQUEST", `Running Goal ${goal.id} has no main Session claim`, 409);
  }
  if (requestedMainSessionId !== undefined && requestedMainSessionId !== goal.mainSessionId) {
    throw new ServerError("BAD_REQUEST", `Goal ${goal.id} is already reserved for session ${goal.mainSessionId}`, 409);
  }
  return goal.mainSessionId;
}

function goalExecutionCwdFromState(goal: GoalState, workspaceRoot: string): string {
  if (!goal.useWorktree) return workspaceRoot;
  if (goal.worktree === undefined) {
    throw new ServerError("BAD_REQUEST", `Running Goal ${goal.id} has no managed worktree claim`, 409);
  }
  return goal.worktree.path;
}


async function validateProvidedSessions(
  runtime: AgentRuntime,
  workspaceRoot: string,
  goal: GoalState,
  body: SessionIdsBody,
  expectedCwd?: string,
): Promise<void> {
  if (body.mainSessionId !== undefined) {
    await assertSessionAssignable(runtime, workspaceRoot, goal, body.mainSessionId, "main", expectedCwd);
  }

  for (const childSessionId of body.childSessionIds ?? []) {
    await assertSessionAssignable(runtime, workspaceRoot, goal, childSessionId, "child", expectedCwd);
  }
}

async function validateGoalSessionIdentities(
  runtime: AgentRuntime,
  workspaceRoot: string,
  goal: GoalState,
  body: SessionIdsBody,
): Promise<void> {
  const mainSessionIds = new Set([goal.mainSessionId, body.mainSessionId].filter((id): id is string => id !== undefined));
  for (const mainSessionId of mainSessionIds) {
    await assertSessionAssignable(runtime, workspaceRoot, goal, mainSessionId, "main");
  }

  const childSessionIds = new Set([...goal.childSessionIds, ...(body.childSessionIds ?? [])]);
  for (const childSessionId of childSessionIds) {
    if (mainSessionIds.has(childSessionId)) continue;
    await assertSessionAssignable(runtime, workspaceRoot, goal, childSessionId, "child");
  }
}

async function assertNoActiveGoalSessions(
  runtime: AgentRuntime,
  workspaceRoot: string,
  goal: GoalState,
  body: SessionIdsBody,
): Promise<void> {
  const sessionIds = new Set([
    goal.mainSessionId,
    ...goal.childSessionIds,
    body.mainSessionId,
    ...(body.childSessionIds ?? []),
  ].filter((id): id is string => id !== undefined));
  let activeSessionId: string | undefined;
  for (const sessionId of sessionIds) {
    if (await isSessionFamilyActive(runtime, workspaceRoot, sessionId)) {
      activeSessionId = sessionId;
      break;
    }
  }
  if (activeSessionId === undefined) return;
  throw new ServerError(
    "BAD_REQUEST",
    `Goal ${goal.id} cannot transition while Session ${activeSessionId} is active`,
    409,
  );
}

async function isSessionFamilyActive(
  runtime: AgentRuntime,
  workspaceRoot: string,
  sessionId: string,
): Promise<boolean> {
  const session = await runtime.getSessionFile(workspaceRoot, sessionId);
  return runtime.getSessionFamilyActivity(workspaceRoot, session.rootSessionId) !== "idle";
}

async function assertSessionAssignable(
  runtime: AgentRuntime,
  workspaceRoot: string,
  goal: GoalState,
  sessionId: string,
  role: "main" | "child",
  expectedCwd?: string,
): Promise<void> {
  let session: Awaited<ReturnType<AgentRuntime["getSessionFile"]>>;
  try {
    session = await runtime.getSessionFile(workspaceRoot, sessionId);
  } catch {
    throw new BadRequestError(`${role === "main" ? "mainSessionId" : "childSessionIds"} must reference an existing session in this project`);
  }

  if (session.goalId === undefined) {
    throw new ServerError("BAD_REQUEST", `Session ${sessionId} is not assigned to Goal ${goal.id}`, 409);
  }
  if (session.goalId !== goal.id) {
    throw new ServerError("BAD_REQUEST", `Session ${sessionId} belongs to a different goal`, 409);
  }
  if (role === "main" && session.sessionRole !== "main") {
    throw new ServerError("BAD_REQUEST", `Session ${sessionId} is not a main goal session`, 409);
  }
  if (expectedCwd !== undefined && session.cwd !== expectedCwd) {
    throw new ServerError("BAD_REQUEST", `Session ${sessionId} does not use the Goal execution directory`, 409);
  }
}

async function reserveGoalSession(
  runtime: AgentRuntime,
  manager: GoalStateManagerForRoute,
  workspaceRoot: string,
  goal: GoalState,
  body: SessionIdsBody,
  cwd: string,
): Promise<GoalState> {
  if (goal.mainSessionId !== undefined && body.mainSessionId !== undefined && goal.mainSessionId !== body.mainSessionId) {
    throw new ServerError("BAD_REQUEST", `Goal ${goal.id} is already reserved for session ${goal.mainSessionId}`, 409);
  }

  const mainSessionId = goal.mainSessionId ?? body.mainSessionId ?? (await runtime.createSession(workspaceRoot, {
    goalId: goal.id,
    sessionRole: "main",
    cwd,
  })).sessionId;

  return await ensureReservedSessions(manager, goal, mainSessionId, body.childSessionIds);
}

async function ensureReservedSessions(
  manager: GoalStateManagerForRoute,
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

async function goalStateFor(runtime: AgentRuntime, workspaceRoot: string): Promise<GoalStateManagerForRoute> {
  const context = await runtime.contextResolver.resolve(workspaceRoot);
  return context.goalState as unknown as GoalStateManagerForRoute;
}

async function prepareGoalWorkspace(
  manager: GoalStateManagerForRoute,
  workspaceRoot: string,
  goal: GoalState,
): Promise<{ goal: GoalState; cwd: string }> {
  const prepared = await new GoalWorkspaceService({
    canonicalRoot: workspaceRoot,
    goalStateManager: manager,
  }).prepare(goal.id);
  return prepared;
}

async function markGoalRunStartFailure(
  manager: GoalStateManagerForRoute,
  goalId: string,
  error: unknown,
): Promise<void> {
  if (manager.fail === undefined) return;
  try {
    await manager.fail(goalId, new Error(`Goal run could not start: ${errorMessage(error)}`));
  } catch {
    // Best-effort annotation: preserve the original execution-start error.
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
    || hasErrorName(error, "GoalCancellationError")
    || hasErrorName(error, "GoalCancellationInProgressError")
    || hasErrorName(error, "SessionFamilyStopConflictError")
    || hasErrorName(error, "SessionFamilyStopInProgressError")
    || hasErrorName(error, "WorktreeServiceError")
  ) {
    return new ServerError("BAD_REQUEST", error.message, 409);
  }
  if (
    hasErrorName(error, "GoalPathError")
    || hasErrorName(error, "GoalInvalidIdError")
  ) {
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
