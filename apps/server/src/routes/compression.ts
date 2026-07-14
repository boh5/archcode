import { Hono } from "hono";
import { SessionFileNotFoundError } from "@archcode/agent-core";
import type { AgentRuntime } from "@archcode/agent-core";
import { z } from "zod/v4";
import { ServerError, SessionNotFoundError } from "../errors";
import { resolveProject } from "../resolve";
import { zValidator } from "../validation";

const CompressionParamsSchema = z.strictObject({
  slug: z.string().min(1),
  sessionId: z.string().min(1),
  blockRef: z.string().min(1),
});

export function createCompressionRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/:blockRef/original", zValidator("param", CompressionParamsSchema), async (c) => {
    const { slug, sessionId, blockRef } = c.req.valid("param");
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

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
