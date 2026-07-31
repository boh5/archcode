import {
  SessionFamilyActiveError,
  SessionFamilyStopInProgressError,
  SessionCommandConflictError,
  SessionCommandOutcomeError,
  SessionInputConflictError,
  SessionSteerUnavailableError,
  SessionToolBatchActiveError,
  type AgentRuntime,
} from "@archcode/agent-core";
import {
  isSessionMessageUnavailableCode,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type AttachmentDescriptor,
  type SessionMessageUnavailableCode,
} from "@archcode/protocol";
import { Hono } from "hono";
import { z } from "zod/v4";
import { ServerError } from "../errors";
import { resolveProject } from "../resolve";
import { zValidator } from "../validation";
import { mapAttachmentHttpError } from "./attachment-http-error";

const MessageBodySchema = z.strictObject({
  text: z.string({ error: "text is required" }),
  attachmentIds: z.array(z.uuid())
    .max(MAX_ATTACHMENTS_PER_MESSAGE)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      { message: "attachmentIds must not contain duplicates" },
    ),
  clientRequestId: z.uuid(),
  requestedModelSelection: z.strictObject({
    mode: z.enum(["profile_default", "session_override"]),
    selection: z.strictObject({
      model: z.string().trim().min(1),
      variant: z.string().trim().min(1).optional(),
    }),
  }),
}).superRefine((body, ctx) => {
  if (body.text.trim().length === 0 && body.attachmentIds.length === 0) {
    ctx.addIssue({ code: "custom", path: ["text"], message: "text or attachmentIds is required" });
  }
  if (body.attachmentIds.length > 0 && body.text.trimStart().startsWith("/")) {
    ctx.addIssue({ code: "custom", path: ["attachmentIds"], message: "Slash commands cannot include attachments" });
  }
});

const EditMessageBodySchema = z.strictObject({
  text: z.string({ error: "text is required" }),
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
    const { text, attachmentIds, clientRequestId, requestedModelSelection } = c.req.valid("json");
    const project = await resolveProject(runtime, slug);

    try {
      const accepted = await runtime.acceptSessionMessage({
        slug,
        sessionId,
        workspaceRoot: project.workspaceRoot,
        text,
        attachmentIds,
        clientRequestId,
        source: "user",
        requestedModelSelection,
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
      throw mapMessageMutationError(error, sessionId);
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
        throw mapMessageMutationError(error, sessionId);
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
        throw mapMessageMutationError(error, sessionId);
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
        throw mapMessageMutationError(error, sessionId);
      }
    },
  );

  return app;
}

function toPendingMessageResult(message: {
  readonly id: string;
  readonly clientRequestId: string;
  readonly content: string;
  readonly attachments: readonly AttachmentDescriptor[];
  readonly state: "queued" | "steering";
  readonly revision: number;
}) {
  return {
    messageId: message.id,
    clientRequestId: message.clientRequestId,
    content: message.content,
    attachments: message.attachments,
    status: message.state,
    revision: message.revision,
  };
}

function mapMessageMutationError(error: unknown, sessionId: string): unknown {
  if (error instanceof ServerError) return error;
  const attachmentError = mapAttachmentHttpError(error, sessionId);
  if (attachmentError !== undefined) return attachmentError;
  if (error instanceof SessionInputConflictError) {
    return new ServerError("BAD_REQUEST", error.message, 409, {
      scopeCode: "SESSION_INPUT_CONFLICT",
      reason: error.reason,
      ...(error.current === undefined ? {} : { current: error.current }),
    });
  }
  const unavailableCode = sessionMessageUnavailableCode(error);
  if (unavailableCode !== undefined) {
    return new ServerError("BAD_REQUEST", errorMessage(error), 409, {
      scopeCode: unavailableCode,
      sessionId: codedErrorValue(error, "sessionId") ?? sessionId,
      ...(codedErrorValue(error, "rootSessionId") === undefined
        ? {}
        : { rootSessionId: codedErrorValue(error, "rootSessionId") }),
      ...(codedStringArray(error, "hitlIds") === undefined
        ? {}
        : { hitlIds: codedStringArray(error, "hitlIds") }),
    });
  }
  const errorCode = codedErrorValue(error, "code");
  if (
    error instanceof SessionSteerUnavailableError
    || error instanceof SessionCommandConflictError
    || errorCode === "SESSION_STEER_UNAVAILABLE"
    || errorCode === "SESSION_COMMAND_CONFLICT"
  ) {
    return new ServerError("BAD_REQUEST", errorMessage(error), 409, {
      scopeCode: errorCode,
      sessionId: codedErrorValue(error, "sessionId") ?? sessionId,
    });
  }
  if (
    error instanceof SessionCommandOutcomeError
    || errorCode === "SESSION_COMMAND_FAILED"
    || errorCode === "SESSION_COMMAND_OUTCOME_INDETERMINATE"
  ) {
    return new ServerError("BAD_REQUEST", errorMessage(error), 409, {
      scopeCode: errorCode,
      sessionId: codedErrorValue(error, "sessionId") ?? sessionId,
      clientRequestId: codedErrorValue(error, "clientRequestId"),
      status: codedErrorValue(error, "status"),
    });
  }
  return error;
}

function sessionMessageUnavailableCode(
  error: unknown,
): SessionMessageUnavailableCode | undefined {
  const code = codedErrorValue(error, "code");
  if (isSessionMessageUnavailableCode(code)) return code;
  if (
    error instanceof SessionFamilyActiveError
    || error instanceof SessionFamilyStopInProgressError
    || error instanceof SessionToolBatchActiveError
    || error instanceof SessionCommandConflictError
  ) {
    return error.code;
  }
  return undefined;
}

function codedErrorValue(error: unknown, key: string): string | undefined {
  if (typeof error !== "object" || error === null || !(key in error)) return undefined;
  const value = Reflect.get(error, key);
  return typeof value === "string" ? value : undefined;
}

function codedStringArray(error: unknown, key: string): readonly string[] | undefined {
  if (typeof error !== "object" || error === null || !(key in error)) return undefined;
  const value = Reflect.get(error, key);
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Session command could not be accepted";
}
