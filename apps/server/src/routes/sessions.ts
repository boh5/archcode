import { Hono } from "hono";
import { NotRootSessionError, SessionDeleteConflictError } from "@specra/agent-core";
import type { SpecraRuntime } from "@specra/agent-core";
import { BadRequestError, ConflictError, SessionNotFoundError } from "../errors";
import { resolveProject } from "../resolve";

export function createSessionsRoutes(runtime: SpecraRuntime): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const sessions = await runtime.listSessions(project.workspaceRoot);

    return c.json({ sessions });
  });

  app.post("/", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    return c.json(await runtime.createSession(project.workspaceRoot), 201);
  });

  app.get("/:sessionId", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const sessionId = requiredParam(c.req.param("sessionId"), "sessionId");

    try {
      return c.json(await runtime.getSessionFile(project.workspaceRoot, sessionId));
    } catch (error) {
      if (isMissingFileError(error)) {
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
      if (isMissingFileError(error)) {
        throw new SessionNotFoundError(sessionId);
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
      if (isMissingFileError(error)) {
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

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
