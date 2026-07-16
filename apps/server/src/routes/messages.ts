import {
  SessionCommandConflictError,
  SessionCommandOutcomeError,
  SessionInputConflictError,
  SessionSteerUnavailableError,
  type AgentRuntime,
} from "@archcode/agent-core";
import { Hono } from "hono";
import { z } from "zod/v4";
import { ServerError } from "../errors";
import { resolveProject } from "../resolve";
import { zValidator } from "../validation";

const MessageBodySchema = z.strictObject({
  text: z.string({ error: "text is required" })
    .refine((value) => value.trim().length > 0, { message: "text is required" }),
  clientRequestId: z.uuid(),
});

const EditMessageBodySchema = z.strictObject({
  text: z.string({ error: "text is required" })
    .refine((value) => value.trim().length > 0, { message: "text is required" }),
  expectedRevision: z.number().int().nonnegative(),
});

const DeleteMessageBodySchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
});

const SteerMessageBodySchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  expectedExecutionId: z.string().trim().min(1),
});

const MessageParamsSchema = z.strictObject({
  slug: z.string().min(1),
  sessionId: z.string().min(1),
});

const PendingMessageParamsSchema = MessageParamsSchema.extend({
  messageId: z.string().min(1),
});

export function createMessagesRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.post("/messages", zValidator("param", MessageParamsSchema), zValidator("json", MessageBodySchema), async (c) => {
    const { slug, sessionId } = c.req.valid("param");
    const { text, clientRequestId } = c.req.valid("json");
    const project = await resolveProject(runtime, slug);

    try {
      const accepted = await runtime.acceptSessionMessage({
        slug,
        sessionId,
        workspaceRoot: project.workspaceRoot,
        text,
        clientRequestId,
        source: "user",
      });
      if (accepted.status === "command") {
        return c.json({ clientRequestId: accepted.clientRequestId, status: "command" as const }, 202);
      }
      if (accepted.status === "deleted") {
        throw new ServerError("BAD_REQUEST", "This message request was already deleted", 409, {
          clientRequestId: accepted.clientRequestId,
          messageId: accepted.messageId,
          status: accepted.status,
        });
      }
      return c.json({
        clientRequestId: accepted.clientRequestId,
        messageId: accepted.messageId,
        status: accepted.status === "pending" ? "queued" as const : "canonical" as const,
      }, 202);
    } catch (error) {
      throw mapMessageMutationError(error);
    }
  });

  app.patch(
    "/messages/:messageId",
    zValidator("param", PendingMessageParamsSchema),
    zValidator("json", EditMessageBodySchema),
    async (c) => {
      const { slug, sessionId, messageId } = c.req.valid("param");
      const { text, expectedRevision } = c.req.valid("json");
      const project = await resolveProject(runtime, slug);
      try {
        const message = await runtime.editPendingSessionMessage({
          workspaceRoot: project.workspaceRoot,
          sessionId,
          messageId,
          expectedRevision,
          text,
        });
        return c.json(toPendingMessageResult(message));
      } catch (error) {
        throw mapMessageMutationError(error);
      }
    },
  );

  app.delete(
    "/messages/:messageId",
    zValidator("param", PendingMessageParamsSchema),
    zValidator("json", DeleteMessageBodySchema),
    async (c) => {
      const { slug, sessionId, messageId } = c.req.valid("param");
      const { expectedRevision } = c.req.valid("json");
      const project = await resolveProject(runtime, slug);
      try {
        const deleted = await runtime.deletePendingSessionMessage({
          workspaceRoot: project.workspaceRoot,
          sessionId,
          messageId,
          expectedRevision,
        });
        return c.json({ ...deleted, status: "deleted" as const });
      } catch (error) {
        throw mapMessageMutationError(error);
      }
    },
  );

  app.post(
    "/messages/:messageId/steer",
    zValidator("param", PendingMessageParamsSchema),
    zValidator("json", SteerMessageBodySchema),
    async (c) => {
      const { slug, sessionId, messageId } = c.req.valid("param");
      const { expectedRevision, expectedExecutionId } = c.req.valid("json");
      const project = await resolveProject(runtime, slug);
      try {
        const message = await runtime.steerPendingSessionMessage({
          workspaceRoot: project.workspaceRoot,
          sessionId,
          messageId,
          expectedRevision,
          expectedExecutionId,
        });
        return c.json(toPendingMessageResult(message));
      } catch (error) {
        throw mapMessageMutationError(error);
      }
    },
  );

  return app;
}

function toPendingMessageResult(message: {
  readonly id: string;
  readonly clientRequestId: string;
  readonly content: string;
  readonly state: "queued" | "steering";
  readonly revision: number;
}) {
  return {
    messageId: message.id,
    clientRequestId: message.clientRequestId,
    content: message.content,
    status: message.state,
    revision: message.revision,
  };
}

function mapMessageMutationError(error: unknown): unknown {
  if (error instanceof ServerError) return error;
  if (error instanceof SessionInputConflictError) {
    return new ServerError("BAD_REQUEST", error.message, 409, {
      scopeCode: "SESSION_INPUT_CONFLICT",
      reason: error.reason,
      ...(error.current === undefined ? {} : { current: error.current }),
    });
  }
  if (error instanceof SessionSteerUnavailableError || error instanceof SessionCommandConflictError) {
    return new ServerError("BAD_REQUEST", error.message, 409, {
      scopeCode: error.code,
      sessionId: error.sessionId,
    });
  }
  if (error instanceof SessionCommandOutcomeError) {
    return new ServerError("BAD_REQUEST", error.message, 409, {
      scopeCode: error.code,
      sessionId: error.sessionId,
      clientRequestId: error.clientRequestId,
      status: error.status,
    });
  }
  return error;
}
