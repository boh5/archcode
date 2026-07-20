import { Hono } from "hono";
import type {
  HitlOwner,
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
import { readBoundedJsonBody } from "../request-body";

interface HitlMutationResponse {
  hitlId: string;
  status: HitlStatus;
  view: HitlView;
}

const HitlListStatusSchema = z.enum(["pending", "recent", "all"]);
const HitlOwnerTypeSchema = z.literal("session");
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

const MAX_HITL_HTTP_BODY_BYTES = 128 * 1024;

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

  app.post("/:slug/hitl/:hitlId/respond", zValidator("param", HitlMutationParamsSchema), async (c) => {
    const { slug, hitlId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    const response = await runHitlMutation(async () => (
      context.hitl.codec.parseResponse(await readBoundedJsonBody(c.req.raw, {
        maxBytes: MAX_HITL_HTTP_BODY_BYTES,
        label: "HITL request body",
      }))
    ));
    if (response.type === "cancel") {
      throw new ServerError("BAD_REQUEST", "Use the HITL cancel endpoint for cancel responses", 400);
    }
    const result = await runHitlMutation(() => runtime.respondToHitl({
      slug: project.slug,
      workspaceRoot: project.workspaceRoot,
      hitlId,
      response,
    }));
    return c.json(toMutationResponse(result));
  });

  app.post("/:slug/hitl/:hitlId/cancel", zValidator("param", HitlMutationParamsSchema), async (c) => {
    const { slug, hitlId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    const body = await readBoundedJsonBody(c.req.raw, {
      maxBytes: MAX_HITL_HTTP_BODY_BYTES,
      label: "HITL request body",
    });
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new ServerError("BAD_REQUEST", "HITL cancel body must be an object", 400);
    }
    const raw = body as Record<string, unknown>;
    const response = await runHitlMutation(async () => context.hitl.codec.parseResponse({
        ...raw,
        type: "cancel",
        reason: raw.reason ?? "Cancelled",
      }));
    if (response.type !== "cancel") throw new Error("HITL codec returned a non-cancel response");
    const result = await runHitlMutation(() => runtime.cancelHitl({
      slug: project.slug,
      workspaceRoot: project.workspaceRoot,
      hitlId,
      reason: response.reason,
      ...(response.cancelledBy === undefined ? {} : { cancelledBy: response.cancelledBy }),
    }));
    return c.json(toMutationResponse(result));
  });

  return app;
}

function matchesOwnerFilter(owner: HitlOwner, ownerType: "session" | undefined, ownerId: string | undefined): boolean {
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
    if (error instanceof z.ZodError) {
      throw new ServerError("BAD_REQUEST", "Invalid HITL boundary payload", 400, { issues: error.issues });
    }
    throw error;
  }
}
