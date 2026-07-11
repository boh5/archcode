import { Hono } from "hono";
import { NotRootSessionError, SessionDeleteConflictError, SessionDeleteInProgressError, SessionDeleteOwnerConflictError, SessionFamilyStopConflictError, SessionFamilyStopInProgressError, SessionFileNotFoundError } from "@archcode/agent-core";
import type { AgentRuntime } from "@archcode/agent-core";
import { BadRequestError, ConflictError, SessionNotFoundError, SessionStopConflictHttpError } from "../errors";
import { resolveProject } from "../resolve";

export function createSessionsRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const sessions = await runtime.listSessions(project.workspaceRoot);

    return c.json({ sessions });
  });

  app.post("/", async (c) => {
    await rejectRequestBody(c.req.text());
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    return c.json(await runtime.createSession(project.workspaceRoot), 201);
  });

  app.get("/:sessionId", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const sessionId = requiredParam(c.req.param("sessionId"), "sessionId");

    try {
      return c.json(await runtime.getSessionFile(project.workspaceRoot, sessionId));
    } catch (error) {
      if (error instanceof SessionFileNotFoundError || isMissingFileError(error)) {
        throw new SessionNotFoundError(sessionId);
      }
      throw error;
    }
  });

  app.get("/:sessionId/tree", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const sessionId = requiredParam(c.req.param("sessionId"), "sessionId");

    try {
      return c.json(await runtime.listSessionTree(project.workspaceRoot, sessionId));
    } catch (error) {
      if (error instanceof NotRootSessionError) {
        throw new BadRequestError(`Session "${sessionId}" is not a root session`);
      }
      if (error instanceof SessionFileNotFoundError || isMissingFileError(error)) {
        throw new SessionNotFoundError(sessionId);
      }
      throw error;
    }
  });

  app.post("/:rootSessionId/stop", async (c) => {
    await rejectRequestBody(c.req.text());
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const rootSessionId = requiredParam(c.req.param("rootSessionId"), "rootSessionId");

    try {
      await runtime.stopSessionFamily(project.workspaceRoot, rootSessionId);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof NotRootSessionError) {
        throw new BadRequestError(`Session "${rootSessionId}" is not a root session`);
      }
      if (error instanceof SessionFamilyStopConflictError) {
        throw new SessionStopConflictHttpError(error.rootSessionId, error.stuckSessionIds, error.message);
      }
      if (error instanceof SessionFamilyStopInProgressError) {
        throw new SessionStopConflictHttpError(error.rootSessionId, [error.sessionId], error.message);
      }
      if (error instanceof SessionDeleteInProgressError) {
        throw new SessionStopConflictHttpError(error.rootSessionId, [error.sessionId], error.message);
      }
      if (error instanceof SessionFileNotFoundError || isMissingFileError(error)) {
        throw new SessionNotFoundError(rootSessionId);
      }
      throw error;
    }
  });

  app.delete("/:sessionId", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const sessionId = requiredParam(c.req.param("sessionId"), "sessionId");

    try {
      await runtime.deleteSession(project.workspaceRoot, sessionId);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof SessionDeleteConflictError) {
        throw new ConflictError(error.sessionIds);
      }
      if (error instanceof SessionDeleteInProgressError) {
        throw new ConflictError([error.sessionId], error.message, {
          scopeCode: error.code,
          rootSessionId: error.rootSessionId,
        });
      }
      if (error instanceof SessionFamilyStopInProgressError) {
        throw new ConflictError([error.sessionId], error.message, {
          scopeCode: error.code,
          rootSessionId: error.rootSessionId,
        });
      }
      if (error instanceof SessionDeleteOwnerConflictError) {
        throw new ConflictError(error.sessionIds, error.message, {
          scopeCode: error.code,
          owners: error.owners,
        });
      }
      if (error instanceof SessionFileNotFoundError || isMissingFileError(error)) {
        throw new SessionNotFoundError(sessionId);
      }
      throw error;
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

async function rejectRequestBody(bodyPromise: Promise<string>): Promise<void> {
  if ((await bodyPromise).trim().length > 0) {
    throw new BadRequestError("Request body is not supported");
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
