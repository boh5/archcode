import { Hono } from "hono";
import { SessionFileNotFoundError } from "@archcode/agent-core";
import type { AgentRuntime } from "@archcode/agent-core";
import type {
  ProjectSkillInventoryItem,
  ProjectSkillInventoryResponse,
} from "@archcode/protocol";
import { z } from "zod/v4";
import { ServerError, SessionNotFoundError } from "../errors";
import { resolveProject } from "../resolve";
import { zValidator } from "../validation";

const SkillParamsSchema = z.strictObject({ slug: z.string().min(1) });
const SkillCursorSchema = z.string()
  .min(1)
  .max(16 * 1024)
  .regex(/^[A-Za-z0-9_-]+$/);
const SkillQuerySchema = z.strictObject({
  cursor: SkillCursorSchema.optional(),
  sessionId: z.string().trim().min(1).max(128).optional(),
});

type SkillInventoryPage = Awaited<ReturnType<AgentRuntime["skillService"]["inventoryPage"]>>;
type SkillPromptCatalog = Awaited<ReturnType<AgentRuntime["skillService"]["projectPromptCatalog"]>>;

/** Project-scoped Skill discovery and diagnostics for the Web workbench. */
export function createSkillsRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get(
    "/:slug/skills",
    zValidator("param", SkillParamsSchema),
    zValidator("query", SkillQuerySchema),
    async (c) => {
      const { slug } = c.req.valid("param");
      const { cursor, sessionId } = c.req.valid("query");
      const project = await resolveProject(runtime, slug);

      try {
        if (sessionId !== undefined) {
          return c.json(await runtime.getSessionSkillCatalog(
            project.workspaceRoot,
            sessionId,
            cursor,
          ));
        }
        const { page, promptProjection } = await projectSkillInventory(runtime, project.workspaceRoot, cursor);
        const response: ProjectSkillInventoryResponse = {
          items: page.items.map(toInventoryItem),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          promptProjection,
        };
        return c.json(response);
      } catch (error) {
        if (sessionId !== undefined && error instanceof SessionFileNotFoundError) {
          throw new SessionNotFoundError(sessionId);
        }
        if (isDigestBoundCursorError(error)) {
          if (error.code === "SKILL_INVENTORY_CHANGED") {
            throw new ServerError("SKILL_INVENTORY_CHANGED", error.message, 400);
          }
          throw new ServerError("BAD_REQUEST", error.message, 400, { scopeCode: error.code });
        }
        throw error;
      }
    },
  );

  return app;
}

async function projectSkillInventory(
  runtime: AgentRuntime,
  workspaceRoot: string,
  cursor?: string,
): Promise<{ readonly page: SkillInventoryPage; readonly promptProjection: SkillPromptCatalog }> {
  const [page, promptProjection] = await Promise.all([
    runtime.skillService.inventoryPage(workspaceRoot, cursor),
    runtime.skillService.projectPromptCatalog(workspaceRoot),
  ]);
  return { page, promptProjection };
}

function isDigestBoundCursorError(error: unknown): error is Error & { readonly code: string } {
  return error instanceof Error
    && error.name === "DigestBoundCursorError"
    && "code" in error
    && typeof error.code === "string";
}

type SkillInventoryRecordLike = SkillInventoryPage["items"][number];

function toInventoryItem(record: SkillInventoryRecordLike): ProjectSkillInventoryItem {
  const { diagnostic, sourceLabel: _sourceLabel, ...item } = record;
  return diagnostic === undefined
    ? item
    : {
      ...item,
      diagnostic: {
        code: diagnostic.code,
        message: diagnostic.message,
      },
    };
}
