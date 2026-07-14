import { Hono } from "hono";
import { AgentRunningError, ChildSessionCwdMismatchError, ConcurrentSessionLimitError, SessionCwdTransitionInProgressError, SessionDeleteInProgressError, SessionExecutionScopeConflictError, SessionFamilyActiveError, SessionFamilyStopInProgressError, SessionHitlBlockedError, SessionHitlJournalBlockedError, SessionHitlResumeInProgressError } from "@archcode/agent-core";
import type { AgentRuntime } from "@archcode/agent-core";
import { z } from "zod/v4";
import {
  ConcurrentSessionLimitHttpError,
  ServerError,
} from "../errors";
import { resolveProject } from "../resolve";
import { zValidator } from "../validation";

const MessageBodySchema = z.strictObject({
  text: z.string({ error: "text is required" })
    .refine((value) => value.trim().length > 0, { message: "text is required" }),
});
const MessageParamsSchema = z.strictObject({
  slug: z.string().min(1),
  sessionId: z.string().min(1),
});

class AgentAlreadyRunningError extends ServerError {
  constructor() {
    super("BAD_REQUEST", new AgentRunningError().message, 409);
    this.name = "AgentAlreadyRunningError";
  }
}

class SessionCwdTransitionHttpError extends ServerError {
  constructor(error: SessionCwdTransitionInProgressError) {
    super("BAD_REQUEST", error.message, 409);
    this.name = "SessionCwdTransitionHttpError";
  }
}

export function createMessagesRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.post("/messages", zValidator("param", MessageParamsSchema), zValidator("json", MessageBodySchema), async (c) => {
    const { slug, sessionId } = c.req.valid("param");
    const { text } = c.req.valid("json");
    const project = await resolveProject(runtime, slug);

    try {
      await runtime.startSessionMessageExecution({ slug, sessionId, workspaceRoot: project.workspaceRoot, userMessage: text });
      return c.json({ ok: true }, 202);
    } catch (error) {
      if (error instanceof AgentRunningError) {
        throw new AgentAlreadyRunningError();
      }
      if (error instanceof ConcurrentSessionLimitError) {
        throw new ConcurrentSessionLimitHttpError(error.current, error.max);
      }
      if (error instanceof SessionCwdTransitionInProgressError) {
        throw new SessionCwdTransitionHttpError(error);
      }
      if (error instanceof SessionHitlBlockedError || error instanceof SessionHitlResumeInProgressError || error instanceof ChildSessionCwdMismatchError) {
        throw new ServerError("BAD_REQUEST", error.message, 409);
      }
      if (error instanceof SessionHitlJournalBlockedError) {
        throw new ServerError("BAD_REQUEST", error.message, 409, {
          scopeCode: error.code,
          sessionId: error.sessionId,
          hitlIds: [...error.hitlIds],
          phases: [...error.phases],
        });
      }
      if (error instanceof SessionDeleteInProgressError) {
        throw new ServerError("BAD_REQUEST", error.message, 409, {
          scopeCode: error.code,
          sessionId: error.sessionId,
          rootSessionId: error.rootSessionId,
        });
      }
      if (error instanceof SessionFamilyStopInProgressError) {
        throw new ServerError("BAD_REQUEST", error.message, 409, {
          scopeCode: error.code,
          sessionId: error.sessionId,
          rootSessionId: error.rootSessionId,
        });
      }
      if (error instanceof SessionFamilyActiveError) {
        throw new ServerError("BAD_REQUEST", error.message, 409, {
          scopeCode: error.code,
          sessionId: error.sessionId,
          rootSessionId: error.rootSessionId,
          activity: error.activity,
        });
      }
      if (error instanceof SessionExecutionScopeConflictError) {
        throw new ServerError("BAD_REQUEST", error.message, 409, {
          ...error.details,
          scopeCode: error.code,
          sessionId: error.sessionId,
        });
      }
      throw error;
    }
  });

  return app;
}
