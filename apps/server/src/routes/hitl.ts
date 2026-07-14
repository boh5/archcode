import { Hono } from "hono";
import type {
  HitlOwner,
  HitlResponse,
  HitlStatus,
  HitlView,
} from "@archcode/protocol";
import {
  HitlConflictError,
  HitlNotFoundError,
  toHitlView,
  type AgentRuntime,
} from "@archcode/agent-core";
import { z } from "zod/v4";
import { resolveProject } from "../resolve";
import { ServerError } from "../errors";
import { zValidator } from "../validation";

interface HitlMutationResponse {
  hitlId: string;
  status: HitlStatus;
  view: HitlView;
}

const HitlListStatusSchema = z.enum(["pending", "recent", "all"]);
const HitlOwnerTypeSchema = z.enum(["session", "goal"]);
const HitlListParamsSchema = z.strictObject({ slug: z.string().min(1) });
const HitlMutationParamsSchema = z.strictObject({
  slug: z.string().min(1),
  hitlId: z.string().min(1),
});
const HitlListQuerySchema = z.strictObject({
  ownerType: HitlOwnerTypeSchema.optional(),
  ownerId: z.string().trim().min(1).optional(),
  status: HitlListStatusSchema.default("pending"),
}).superRefine((query, context) => {
  if (query.ownerId !== undefined && query.ownerType === undefined) {
    context.addIssue({ code: "custom", path: ["ownerType"], message: "ownerType is required with ownerId" });
  }
});

const HitlResponseSchema: z.ZodType<Exclude<HitlResponse, { type: "cancel" }>> = z.union([
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
    type: z.literal("budget_decision"),
    decision: z.enum(["approved", "denied"]),
    comment: z.string().optional(),
    decidedBy: z.string().optional(),
  }),
]);

const HitlCancelBodySchema = z.strictObject({
  reason: z.string().trim().min(1).optional(),
  cancelledBy: z.string().optional(),
});

interface HitlMutationResult {
  hitlId: string;
  status: HitlStatus;
  view: HitlView;
}

export function createHitlRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/:slug/hitl", zValidator("param", HitlListParamsSchema), zValidator("query", HitlListQuerySchema), async (c) => {
    const project = await resolveProject(runtime, c.req.valid("param").slug);
    const query = c.req.valid("query");
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    const statuses: HitlStatus[] = query.status === "pending" ? ["pending"] : query.status === "recent" ? ["answered", "resolved", "cancelled"] : ["pending", "answered", "resolved", "cancelled"];
    const records = await context.hitl.list({ statuses });
    const views = records
      .filter((record) => matchesOwnerFilter(record.owner, query.ownerType, query.ownerId))
      .map(toHitlView);
    return c.json({ hitl: views });
  });

  app.post("/:slug/hitl/:hitlId/respond", zValidator("param", HitlMutationParamsSchema), zValidator("json", HitlResponseSchema), async (c) => {
    const { slug, hitlId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    const result = await runHitlMutation(() => runtime.respondToHitl({
      slug: project.slug,
      workspaceRoot: project.workspaceRoot,
      hitlId,
      response: c.req.valid("json"),
    }));
    return c.json(toMutationResponse(result));
  });

  app.post("/:slug/hitl/:hitlId/cancel", zValidator("param", HitlMutationParamsSchema), zValidator("json", HitlCancelBodySchema), async (c) => {
    const { slug, hitlId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    const body = c.req.valid("json");
    const result = await runHitlMutation(() => runtime.cancelHitl({
      slug: project.slug,
      workspaceRoot: project.workspaceRoot,
      hitlId,
      reason: body.reason ?? "Cancelled",
      ...(body.cancelledBy === undefined ? {} : { cancelledBy: body.cancelledBy }),
    }));
    return c.json(toMutationResponse(result));
  });

  return app;
}

function matchesOwnerFilter(owner: HitlOwner, ownerType: "session" | "goal" | undefined, ownerId: string | undefined): boolean {
  return ownerType === undefined || (owner.type === ownerType && (ownerId === undefined || owner.id === ownerId));
}

function toMutationResponse(result: HitlMutationResult): HitlMutationResponse {
  return { hitlId: result.hitlId, status: result.status, view: result.view };
}

async function runHitlMutation<T>(mutation: () => Promise<T>): Promise<T> {
  try {
    return await mutation();
  } catch (error) {
    if (error instanceof HitlNotFoundError) {
      throw new ServerError("HITL_NOT_FOUND", error.message, 404);
    }
    if (error instanceof HitlConflictError) {
      throw new ServerError("BAD_REQUEST", error.message, 409);
    }
    throw error;
  }
}
