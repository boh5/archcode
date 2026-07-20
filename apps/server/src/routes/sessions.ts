import { Hono } from "hono";
import {
  NotRootSessionError,
  SessionDeleteConflictError,
  SessionDeleteInProgressError,
  SessionDeleteOwnerConflictError,
  SessionFamilyStopConflictError,
  SessionFamilyStopInProgressError,
  SessionFileNotFoundError,
  SessionGoalServiceError,
  SessionModelSelectionConflictError,
  SessionModelSelectionInvalidError,
} from "@archcode/agent-core";
import type { AgentRuntime } from "@archcode/agent-core";
import { z } from "zod/v4";
import { BadRequestError, ConflictError, ServerError, SessionNotFoundError, SessionStopConflictHttpError } from "../errors";
import { resolveProject } from "../resolve";
import { zValidator } from "../validation";

const ProjectParamsSchema = z.strictObject({ slug: z.string().min(1) });
const SessionParamsSchema = z.strictObject({
  slug: z.string().min(1),
  sessionId: z.string().min(1),
});
const RootSessionParamsSchema = z.strictObject({
  slug: z.string().min(1),
  rootSessionId: z.string().min(1),
});
const ModelSelectionSchema = z.strictObject({
  mode: z.enum(["agent_default", "session_override"]),
  selection: z.strictObject({
    model: z.string().trim().min(1),
    variant: z.string().trim().min(1).optional(),
  }),
});
const PatchModelSelectionSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  requestedModelSelection: ModelSelectionSchema,
});
const EditSessionGoalSchema = z.strictObject({
  objective: z.string().trim().min(1).max(4000),
  expectedGeneration: z.number().int().positive(),
});
const SessionGoalBudgetSchema = z.strictObject({
  tokenBudget: z.number().int().positive().nullable(),
});

export function createSessionsRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/", zValidator("param", ProjectParamsSchema), async (c) => {
    const project = await resolveProject(runtime, c.req.valid("param").slug);
    const sessions = await runtime.listSessions(project.workspaceRoot);

    return c.json({ sessions });
  });

  app.post("/", zValidator("param", ProjectParamsSchema), async (c) => {
    await rejectRequestBody(c.req.text());
    const project = await resolveProject(runtime, c.req.valid("param").slug);
    return c.json(await runtime.createSession(project.workspaceRoot, { agentName: "engineer" }), 201);
  });

  app.get("/:sessionId", zValidator("param", SessionParamsSchema), async (c) => {
    const { slug, sessionId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);

    try {
      return c.json(await runtime.getSessionFile(project.workspaceRoot, sessionId));
    } catch (error) {
      if (error instanceof SessionFileNotFoundError || isMissingFileError(error)) {
        throw new SessionNotFoundError(sessionId);
      }
      throw error;
    }
  });

  app.get("/:sessionId/model-selection", zValidator("param", SessionParamsSchema), async (c) => {
    const { slug, sessionId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    try {
      return c.json(await runtime.getSessionModelState(project.workspaceRoot, sessionId));
    } catch (error) {
      if (error instanceof SessionFileNotFoundError || isMissingFileError(error)) {
        throw new SessionNotFoundError(sessionId);
      }
      throw error;
    }
  });

  app.patch(
    "/:sessionId/model-selection",
    zValidator("param", SessionParamsSchema),
    zValidator("json", PatchModelSelectionSchema),
    async (c) => {
      const { slug, sessionId } = c.req.valid("param");
      const project = await resolveProject(runtime, slug);
      try {
        return c.json(await runtime.patchSessionModelSelection({
          workspaceRoot: project.workspaceRoot,
          sessionId,
          ...c.req.valid("json"),
        }));
      } catch (error) {
        if (error instanceof SessionModelSelectionConflictError) {
          throw new ServerError("BAD_REQUEST", error.message, 409, {
            scopeCode: "SESSION_MODEL_SELECTION_CONFLICT",
            expectedRevision: error.expectedRevision,
            current: error.current,
          });
        }
        if (error instanceof SessionModelSelectionInvalidError) {
          throw new ServerError("BAD_REQUEST", error.message, 422, {
            scopeCode: "SESSION_MODEL_SELECTION_INVALID",
            requested: error.requested,
          });
        }
        if (error instanceof SessionFileNotFoundError || isMissingFileError(error)) {
          throw new SessionNotFoundError(sessionId);
        }
        throw error;
      }
    },
  );

  app.get("/:sessionId/tree", zValidator("param", SessionParamsSchema), async (c) => {
    const { slug, sessionId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);

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

  app.patch(
    "/:sessionId/goal",
    zValidator("param", SessionParamsSchema),
    zValidator("json", EditSessionGoalSchema),
    async (c) => {
      const { slug, sessionId } = c.req.valid("param");
      const project = await resolveProject(runtime, slug);
      await applySessionGoalControl(runtime, {
        workspaceRoot: project.workspaceRoot,
        sessionId,
        action: "edit",
        ...c.req.valid("json"),
      });
      return c.json(await runtime.getSessionFile(project.workspaceRoot, sessionId));
    },
  );

  for (const action of ["pause", "resume"] as const) {
    app.post(`/:sessionId/goal/${action}`, zValidator("param", SessionParamsSchema), async (c) => {
      await rejectRequestBody(c.req.text());
      const { slug, sessionId } = c.req.valid("param");
      const project = await resolveProject(runtime, slug);
      await applySessionGoalControl(runtime, {
        workspaceRoot: project.workspaceRoot,
        sessionId,
        action,
      });
      return c.json(await runtime.getSessionFile(project.workspaceRoot, sessionId));
    });
  }

  app.post(
    "/:sessionId/goal/budget",
    zValidator("param", SessionParamsSchema),
    zValidator("json", SessionGoalBudgetSchema),
    async (c) => {
      const { slug, sessionId } = c.req.valid("param");
      const project = await resolveProject(runtime, slug);
      const { tokenBudget } = c.req.valid("json");
      await applySessionGoalControl(runtime, {
        workspaceRoot: project.workspaceRoot,
        sessionId,
        action: "budget",
        tokenBudget: tokenBudget ?? undefined,
      });
      return c.json(await runtime.getSessionFile(project.workspaceRoot, sessionId));
    },
  );

  app.delete("/:sessionId/goal", zValidator("param", SessionParamsSchema), async (c) => {
    const { slug, sessionId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    await applySessionGoalControl(runtime, {
      workspaceRoot: project.workspaceRoot,
      sessionId,
      action: "clear",
    });
    return c.json({ ok: true });
  });

  app.post("/:rootSessionId/stop", zValidator("param", RootSessionParamsSchema), async (c) => {
    await rejectRequestBody(c.req.text());
    const { slug, rootSessionId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);

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

  app.delete("/:sessionId", zValidator("param", SessionParamsSchema), async (c) => {
    const { slug, sessionId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);

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

async function rejectRequestBody(bodyPromise: Promise<string>): Promise<void> {
  if ((await bodyPromise).trim().length > 0) {
    throw new BadRequestError("Request body is not supported");
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function applySessionGoalControl(
  runtime: AgentRuntime,
  input: Parameters<AgentRuntime["updateSessionGoalControl"]>[0],
): Promise<void> {
  try {
    await runtime.updateSessionGoalControl(input);
  } catch (error) {
    if (error instanceof SessionGoalServiceError) {
      if (error.code === "GENERATION_CONFLICT") {
        throw new ServerError("BAD_REQUEST", error.message, 409, { scopeCode: error.code });
      }
      throw new ServerError("BAD_REQUEST", error.message, 422, { scopeCode: error.code });
    }
    if (error instanceof SessionFileNotFoundError || isMissingFileError(error)) {
      throw new SessionNotFoundError(input.sessionId);
    }
    throw error;
  }
}
