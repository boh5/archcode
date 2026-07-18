import { Hono } from "hono";
import {
  SessionFileNotFoundError,
  ToolOutputError,
  type AgentRuntime,
} from "@archcode/agent-core";
import { z } from "zod/v4";
import { BadRequestError, ServerError, SessionNotFoundError } from "../errors";
import { resolveProject } from "../resolve";
import { zValidator } from "../validation";
import { readBoundedJsonBody } from "../request-body";

const SEARCH_BODY_MAX_BYTES = 16 * 1024;
const CURSOR_MAX_BYTES = 16 * 1024;
const CursorSchema = z.string().min(1).max(CURSOR_MAX_BYTES).regex(/^[A-Za-z0-9_-]+$/);

const ParamsSchema = z.strictObject({
  slug: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  outputRef: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
});

const SearchParamsSchema = z.strictObject({
  slug: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
});

const ReadQuerySchema = z.strictObject({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1_000).optional(),
});

const SearchBodySchema = z.strictObject({
  outputRef: z.string().regex(/^[A-Za-z0-9_-]{22}$/).optional(),
  pattern: z.string().min(1).max(1_024),
  cursor: CursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export function createToolOutputRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get(
    "/:outputRef",
    zValidator("param", ParamsSchema),
    zValidator("query", ReadQuerySchema),
    async (c) => {
      const { slug, sessionId, outputRef } = c.req.valid("param");
      const project = await resolveProject(runtime, slug);
      try {
        return c.json(await runtime.readToolOutput(
          project.workspaceRoot,
          sessionId,
          { outputRef, ...c.req.valid("query") },
        ));
      } catch (error) {
        throw mapToolOutputError(error, sessionId);
      }
    },
  );

  app.post("/search", zValidator("param", SearchParamsSchema), async (c) => {
    const { slug, sessionId } = c.req.valid("param");
    const body = SearchBodySchema.safeParse(await readBoundedJsonBody(c.req.raw, {
      maxBytes: SEARCH_BODY_MAX_BYTES,
      label: "Tool output search request body",
    }));
    if (!body.success) {
      throw new BadRequestError(body.error.issues[0]?.message ?? "Request body is invalid");
    }
    const project = await resolveProject(runtime, slug);
    try {
      return c.json(await runtime.searchToolOutputs(project.workspaceRoot, sessionId, body.data));
    } catch (error) {
      throw mapToolOutputError(error, sessionId);
    }
  });

  return app;
}

function mapToolOutputError(error: unknown, sessionId: string): Error {
  if (error instanceof SessionFileNotFoundError || isMissingFileError(error)) {
    return new SessionNotFoundError(sessionId);
  }
  if (!(error instanceof ToolOutputError)) return error instanceof Error ? error : new Error(String(error));

  const status = TOOL_OUTPUT_HTTP_STATUS[error.code];
  return new ServerError(error.code, error.message, status);
}

const TOOL_OUTPUT_HTTP_STATUS = {
  TOOL_OUTPUT_FORBIDDEN: 403,
  TOOL_OUTPUT_NOT_FOUND: 404,
  TOOL_OUTPUT_EXPIRED: 410,
  TOOL_OUTPUT_EVICTED: 410,
  TOOL_OUTPUT_UNAVAILABLE: 503,
  TOOL_OUTPUT_INVALID_CURSOR: 400,
  TOOL_OUTPUT_INVALID_PATTERN: 400,
  TOOL_OUTPUT_SEARCH_TIMEOUT: 408,
  TOOL_OUTPUT_POLICY_VIOLATION: 400,
} as const;

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
