import { Hono } from "hono";
import { SessionFileNotFoundError } from "@archcode/agent-core";
import type { AgentRuntime } from "@archcode/agent-core";
import { BadRequestError, ServerError, SessionNotFoundError } from "../errors";
import { resolveProject } from "../resolve";

export function createCompressionRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/:blockRef/original", async (c) => {
    const slug = requiredParam(c.req.param("slug"), "slug");
    const sessionId = requiredParam(c.req.param("sessionId"), "sessionId");
    const blockRef = requiredParam(c.req.param("blockRef"), "blockRef");
    const project = await resolveProject(runtime, slug);

    try {
      const result = await runtime.resolveCompressionOriginalRange(project.workspaceRoot, sessionId, blockRef);
      if (result.ok) return c.json(result);

      if (result.code === "not_found") {
        throw new ServerError("SESSION_NOT_FOUND", `Compression block not found: ${blockRef}`, 404, {
          blockRef,
          reason: result.reason,
        });
      }

      return c.json(result, 422);
    } catch (error) {
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

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
