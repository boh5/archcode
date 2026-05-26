import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { getSessionsDir } from "@specra/agent-core";
import type { SpecraRuntime } from "@specra/agent-core";
import type { AgentRunner } from "../agent-runner";
import { BadRequestError, SessionNotFoundError } from "../errors";
import { unregisterSessionEventBridge } from "../events/session-event-bridge";
import { resolveProject } from "../resolve";

export function createSessionsRoutes(runtime: SpecraRuntime, agentRunner: AgentRunner): Hono {
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

  app.delete("/:sessionId", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const sessionId = requiredParam(c.req.param("sessionId"), "sessionId");

    await agentRunner.abortAndWait(project.workspaceRoot, sessionId);
    runtime.disposeSessionAgent(project.workspaceRoot, sessionId);
    unregisterSessionEventBridge(project.workspaceRoot, sessionId);
    agentRunner.cleanupSession(project.workspaceRoot, sessionId);

    const path = join(getSessionsDir(project.workspaceRoot), `${sessionId}.json`);

    if (await Bun.file(path).exists()) {
      await rm(path);
    }

    return c.json({ ok: true });
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
