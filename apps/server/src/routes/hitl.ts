import { Hono } from "hono";
import type {
  HitlAllowedAction,
  HitlIdentity,
  HitlOwnerType,
  HitlProjection,
  HitlRecord,
  HitlResponse,
  HitlSource,
  HitlStatus,
  GlobalSSEEvent,
} from "@archcode/protocol";
import { GoalReviewOutcomeResponseSchema, hitlRequiresInspection, type AgentRuntime, type ProjectContext, type ResumeCoordinatorResult } from "@archcode/agent-core";
import { sortJsonValue } from "@archcode/utils";
import { z } from "zod/v4";
import { BadRequestError, ServerError } from "../errors";
import { resolveProject } from "../resolve";
import { globalEventBus } from "../events/global-event-bus";
import { zValidator } from "../validation";

type HitlRouteScope = "project" | "session" | "goal";
type HitlRouteStatus = "pending" | "recent" | "all";

interface HitlMutationResponse {
  hitlId: string;
  status: HitlStatus;
  hitl: HitlProjection;
}

const HitlListStatusSchema = z.enum(["pending", "recent", "all"]);
const HitlScopeSchema = z.enum(["project", "session", "goal"]);
const HitlOwnerTypeSchema = z.enum(["session", "goal"]);
const HitlListParamsSchema = z.strictObject({ slug: z.string().min(1) });
const HitlMutationParamsSchema = z.strictObject({
  slug: z.string().min(1),
  ownerType: HitlOwnerTypeSchema,
  ownerId: z.string().min(1),
  hitlId: z.string().min(1),
});
const HitlListQuerySchema = z.strictObject({
  scope: HitlScopeSchema.default("project"),
  ownerId: z.string().trim().min(1).optional(),
  includeChildren: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  status: HitlListStatusSchema.default("pending"),
}).superRefine((query, context) => {
  if (query.scope !== "project" && query.ownerId === undefined) {
    context.addIssue({ code: "custom", path: ["ownerId"], message: "ownerId is required for session and goal HITL scope" });
  }
  if (query.scope === "project" && query.ownerId !== undefined) {
    context.addIssue({ code: "custom", path: ["ownerId"], message: "ownerId is only valid for session and goal HITL scope" });
  }
});

const HitlResponseSchema: z.ZodType<HitlResponse> = z.union([
  z.strictObject({
    type: z.literal("question_answer"),
    answers: z.array(z.string()),
    comment: z.string().optional(),
    answeredBy: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("permission_decision"),
    decision: z.enum(["approve_once", "approve_always", "deny"]),
    comment: z.string().optional(),
    decidedBy: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("approval_decision"),
    decision: z.enum(["approved", "denied"]),
    comment: z.string().optional(),
    decidedBy: z.string().optional(),
  }),
  GoalReviewOutcomeResponseSchema,
  z.strictObject({
    type: z.literal("cancel"),
    reason: z.string(),
    cancelledBy: z.string().optional(),
  }),
]);

const HitlCancelBodySchema = z.strictObject({
  reason: z.string().trim().min(1).optional(),
  cancelledBy: z.string().optional(),
});

const TERMINAL_STATUSES = new Set<HitlStatus>(["resolved", "cancelled"]);

export function createHitlRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/:slug/hitl", zValidator("param", HitlListParamsSchema), zValidator("query", HitlListQuerySchema), async (c) => {
    const project = await resolveProject(runtime, c.req.valid("param").slug);
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    const query = c.req.valid("query");
    await assertOwnerExists(runtime, project.workspaceRoot, context, query.scope, query.ownerId);

    const hitl = (await context.hitl.list({
      scope: query.scope,
      ...(query.ownerId === undefined ? {} : { ownerId: query.ownerId }),
      includeChildren: query.includeChildren,
      status: statusForService(query.status),
    }));

    return c.json({ hitl });
  });

  app.post("/:slug/hitl/:ownerType/:ownerId/:hitlId/respond", zValidator("param", HitlMutationParamsSchema), zValidator("json", HitlResponseSchema), async (c) => {
    const { slug, ownerType, ownerId, hitlId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    const identity: HitlIdentity = { owner: { projectSlug: project.slug, ownerType, ownerId }, hitlId };
    const response = c.req.valid("json");
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    const lookup = await context.hitl.lookup(identity);
    if (lookup.status === "missing") throw hitlNotFound(hitlId);

    validateResponseForSource(lookup.record.source, response);
    const preflight = nonPendingPreflight(lookup.record, response);
    if (preflight !== undefined) return c.json(toMutationResponse(project, preflight.record), preflight.statusCode);

    const releaseSessionForwarder = await forwardSessionResumeEvents(runtime, project.workspaceRoot, project.slug, identity.owner, hitlId);
    const coordinator = requiredResumeCoordinator(context.hitlResumeCoordinator);
    let result: ResumeCoordinatorResult;
    try {
      result = await coordinator.respond(identity, response);
    } catch (error) {
      releaseSessionForwarder();
      throw error;
    }
    if (!result.scheduled) releaseSessionForwarder();
    const record = recordFromCoordinatorResult(result, hitlId);
    const statusCode = isConflictingMutation(record, response) ? 409 : 200;
    return c.json(toMutationResponse(project, record), statusCode);
  });

  app.post("/:slug/hitl/:ownerType/:ownerId/:hitlId/cancel", zValidator("param", HitlMutationParamsSchema), zValidator("json", HitlCancelBodySchema), async (c) => {
    const { slug, ownerType, ownerId, hitlId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    const identity: HitlIdentity = { owner: { projectSlug: project.slug, ownerType, ownerId }, hitlId };
    const body = c.req.valid("json");
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    const lookup = await context.hitl.lookup(identity);
    if (lookup.status === "missing") throw hitlNotFound(hitlId);

    const response: HitlResponse = {
      type: "cancel",
      reason: body.reason ?? "Cancelled",
      ...(body.cancelledBy === undefined ? {} : { cancelledBy: body.cancelledBy }),
    };
    const preflight = nonPendingPreflight(lookup.record, response);
    if (preflight !== undefined) return c.json(toMutationResponse(project, preflight.record), preflight.statusCode);
    validateCancelAction(lookup.record);

    const releaseSessionForwarder = await forwardSessionResumeEvents(runtime, project.workspaceRoot, project.slug, identity.owner, hitlId);
    const coordinator = requiredResumeCoordinator(context.hitlResumeCoordinator);
    let result: ResumeCoordinatorResult;
    try {
      result = await coordinator.cancel(identity, response.reason, response.cancelledBy);
    } catch (error) {
      releaseSessionForwarder();
      throw error;
    }
    if (!result.scheduled) releaseSessionForwarder();
    const record = recordFromCoordinatorResult(result, hitlId);
    const statusCode = isConflictingMutation(record, response) ? 409 : 200;
    return c.json(toMutationResponse(project, record), statusCode);
  });

  return app;
}

async function forwardSessionResumeEvents(
  runtime: AgentRuntime,
  workspaceRoot: string,
  slug: string,
  owner: HitlRecord["owner"],
  hitlId: string,
): Promise<() => void> {
  if (owner.ownerType !== "session") return () => undefined;

  const sessionId = owner.ownerId;
  const eventCursor = await runtime.getSessionFile(workspaceRoot, sessionId)
    .then((session) => session.eventCursor ?? -1)
    .catch(() => -1);
  let released = false;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeHitl: (() => void) | undefined;
  const timeout = setTimeout(() => release(), 5 * 60 * 1000);

  const release = (): void => {
    if (released) return;
    released = true;
    clearTimeout(timeout);
    unsubscribe?.();
    unsubscribeHitl?.();
  };

  unsubscribe = runtime.subscribeSessionEvents({
    slug,
    workspaceRoot,
    sessionId,
    startEventId: eventCursor + 1,
    onEvent(event) {
      if (!isHitlSessionEvent(event)) globalEventBus.emit(event);
      if (isExecutionEndAfter(event, sessionId, eventCursor)) release();
    },
  });

  unsubscribeHitl = runtime.subscribeHitlEvents((event) => {
    if (event.hitlId === hitlId && event.owner.ownerType === "session" && event.owner.ownerId === sessionId && event.payload.type === "hitl.resolved") release();
  });

  return release;
}

function isHitlSessionEvent(event: GlobalSSEEvent): boolean {
  return event.type === "event" && (
    event.payload.type === "hitl.request"
    || event.payload.type === "hitl.updated"
    || event.payload.type === "hitl.resolved"
  );
}

function isExecutionEndAfter(event: GlobalSSEEvent, sessionId: string, eventCursor: number): boolean {
  return event.type === "event"
    && event.sessionId === sessionId
    && event.payload.type === "execution-end"
    && event.eventId > eventCursor;
}

function statusForService(status: HitlRouteStatus): "active" | "terminal" | "all" {
  switch (status) {
    case "pending":
      return "active";
    case "recent":
      return "terminal";
    case "all":
      return "all";
  }
}

async function assertOwnerExists(
  runtime: AgentRuntime,
  workspaceRoot: string,
  context: ProjectContext,
  scope: HitlRouteScope,
  ownerId: string | undefined,
): Promise<void> {
  if (scope === "project") return;
  const id = ownerId ?? "";
  try {
    if (scope === "session") {
      await runtime.getSessionFile(workspaceRoot, id);
      return;
    }
    if (scope === "goal") {
      await context.goalState.read(id);
      return;
    }
  } catch (error) {
    if (error instanceof ServerError) throw error;
    throw ownerNotFound(scope, id);
  }
}

function validateResponseForSource(source: HitlSource, response: HitlResponse): void {
  const expectedType = responseTypeForSource(source);
  if (response.type !== expectedType) throw invalidResponsePayload(expectedType);
  if (source.type !== "goal_review") return;
  if (response.type !== "review_outcome") throw invalidResponsePayload("review_outcome");
  if (response.receipt.reviewGeneration !== source.reviewGeneration) {
    throw new BadRequestError("Review receipt generation must match the HITL review source");
  }
  if (response.receipt.reviewerSessionId !== source.reviewerSessionId) {
    throw new BadRequestError("Review receipt Reviewer Session must match the HITL review source");
  }
}

function responseTypeForSource(source: HitlSource): Exclude<HitlResponse["type"], "cancel"> {
  switch (source.type) {
    case "ask_user":
    case "goal_question":
      return "question_answer";
    case "tool_permission":
      return "permission_decision";
    case "goal_approval":
    case "goal_budget":
      return "approval_decision";
    case "goal_review":
      return "review_outcome";
  }
}

function validateCancelAction(record: HitlRecord): void {
  if (!allowedActionsFor(record).includes("cancel")) throw new BadRequestError(`Cannot cancel HITL with status ${record.status}`);
}

function nonPendingPreflight(record: HitlRecord, response: HitlResponse): { statusCode: 200 | 409; record: HitlRecord } | undefined {
  if (record.status === "pending") return undefined;
  if (record.response !== undefined) return { statusCode: responsesEquivalent(record.response, response) ? 200 : 409, record };
  if (TERMINAL_STATUSES.has(record.status)) return { statusCode: 409, record };
  throw new BadRequestError(`Cannot mutate HITL with status ${record.status}`);
}

function recordFromCoordinatorResult(
  result: ResumeCoordinatorResult,
  hitlId: string,
): HitlRecord {
  if (result.status === "missing") throw hitlNotFound(hitlId);
  return result.record;
}

function isConflictingMutation(record: HitlRecord, response: HitlResponse): boolean {
  return record.response !== undefined && !responsesEquivalent(record.response, response);
}

function responsesEquivalent(left: HitlResponse | undefined, right: HitlResponse): boolean {
  if (left === undefined) return false;
  return stableJson(left) === stableJson(right);
}

function toMutationResponse(project: { slug: string; name?: string }, record: HitlRecord): HitlMutationResponse {
  return {
    hitlId: record.hitlId,
    status: record.status,
    hitl: toProjection(project, record),
  };
}

function toProjection(project: { slug: string; name?: string }, record: HitlRecord): HitlProjection {
  return {
    hitlId: record.hitlId,
    project: { slug: project.slug, ...(project.name === undefined ? {} : { name: project.name }) },
    owner: record.owner,
    source: record.source,
    status: record.status,
    displayPayload: record.displayPayload,
    allowedActions: allowedActionsFor(record),
    ...(hitlRequiresInspection(record) ? { requiresInspection: true as const } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.resolvedAt === undefined ? {} : { resolvedAt: record.resolvedAt }),
  };
}

function allowedActionsFor(record: HitlRecord): HitlAllowedAction[] {
  if (record.status !== "pending") return [];
  switch (record.source.type) {
    case "ask_user":
    case "goal_question":
      return ["answer", "cancel"];
    case "tool_permission":
      return ["approve", "deny", "cancel"];
    case "goal_approval":
    case "goal_budget":
      return ["approve", "deny", "cancel"];
    case "goal_review":
      return ["approve", "deny", "cancel"];
  }
}

function requiredResumeCoordinator(
  coordinator: ProjectContext["hitlResumeCoordinator"],
): NonNullable<ProjectContext["hitlResumeCoordinator"]> {
  if (coordinator === undefined) throw new ServerError("INTERNAL_ERROR", "HITL resume coordinator is not available", 500);
  return coordinator;
}

function invalidResponsePayload(expectedType: HitlResponse["type"]): BadRequestError {
  return new BadRequestError(`Response type must be ${expectedType}`);
}

function ownerNotFound(scope: HitlOwnerType, ownerId: string): ServerError {
  return new ServerError("QUESTION_NOT_FOUND", `HITL ${scope} owner not found: ${ownerId}`, 404);
}

function hitlNotFound(hitlId: string): ServerError {
  return new ServerError("QUESTION_NOT_FOUND", `HITL request not found: ${hitlId}`, 404);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}
