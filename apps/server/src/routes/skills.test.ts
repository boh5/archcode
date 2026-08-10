import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SessionFileNotFoundError, type AgentRuntime } from "@archcode/agent-core";
import type { ProjectSkillInventoryResponse, SkillPromptProjection } from "@archcode/protocol";
import { errorHandler } from "../error-handler";
import { createSkillsRoutes } from "./skills";

const roots: string[] = [];
type SkillInventoryPage = Awaited<ReturnType<AgentRuntime["skillService"]["inventoryPage"]>>;
type SkillPromptCatalog = Awaited<ReturnType<AgentRuntime["skillService"]["projectPromptCatalog"]>>;

const promptProjection: SkillPromptProjection = {
  includedEntries: [{ name: "review", description: "Review changes", source: "builtin" }],
  omittedCount: 1,
  renderedText: "- review: Review changes (source=builtin)\n- 1 additional Skills omitted; use skill_list to continue discovery.",
  byteLength: 108,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project Skill inventory routes", () => {
  test("returns a cursor page and the canonical Prompt projection for the registered workspace", async () => {
    const fixture = await createFixture();
    const inventory = {
      name: "review",
      source: "builtin" as const,
      sourceLabel: "builtin",
      winner: true,
      shadowed: false,
      valid: true,
      description: "Review changes",
    };
    fixture.runtime.skillService.inventoryPage.mockResolvedValueOnce({
      items: [inventory],
      nextCursor: "cursor-2",
    });
    fixture.runtime.skillService.projectPromptCatalog.mockResolvedValueOnce(promptProjection);

    const response = await fixture.app.request("/api/projects/project/skills?cursor=cursor-1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [{
        name: "review",
        source: "builtin",
        winner: true,
        shadowed: false,
        valid: true,
        description: "Review changes",
      }],
      nextCursor: "cursor-2",
      promptProjection,
    });
    expect(fixture.runtime.skillService.inventoryPage).toHaveBeenCalledWith(fixture.workspaceRoot, "cursor-1");
    expect(fixture.runtime.skillService.projectPromptCatalog).toHaveBeenCalledWith(fixture.workspaceRoot);
    expect(fixture.runtime.getSessionSkillCatalog).not.toHaveBeenCalled();
  });

  test("uses the Session-scoped runtime inventory so worktree cwd and Agent builtin policy stay authoritative", async () => {
    const fixture = await createFixture();
    fixture.runtime.getSessionSkillCatalog.mockResolvedValueOnce({
      items: [
        { name: "orchestrate-work", source: "builtin", winner: true, shadowed: false, valid: true },
        { name: "worktree-custom", source: "project-agents", winner: true, shadowed: false, valid: true },
      ],
      nextCursor: "session-page-2",
      promptProjection: {
        includedEntries: [
          { name: "orchestrate-work", description: "Lead workflow", source: "builtin" },
          { name: "worktree-custom", description: "Worktree custom", source: "project-agents" },
        ],
        omittedCount: 0,
        renderedText: "session skills",
        byteLength: 14,
      },
    });

    const response = await fixture.app.request("/api/projects/project/skills?cursor=session-page-1&sessionId=child-session");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.map((item: { name: string }) => item.name)).toEqual(["orchestrate-work", "worktree-custom"]);
    expect(body.items.map((item: { name: string }) => item.name)).not.toContain("review-change");
    expect(body.nextCursor).toBe("session-page-2");
    expect(fixture.runtime.getSessionSkillCatalog).toHaveBeenCalledWith(
      fixture.workspaceRoot,
      "child-session",
      "session-page-1",
    );
    expect(fixture.runtime.skillService.inventoryPage).not.toHaveBeenCalled();
    expect(fixture.runtime.skillService.projectPromptCatalog).not.toHaveBeenCalled();
  });

  test("keeps invalid-package diagnostics bounded to the Web DTO", async () => {
    const fixture = await createFixture();
    fixture.runtime.skillService.inventoryPage.mockResolvedValueOnce({
      items: [{
        name: "broken",
        source: "project-archcode",
        sourceLabel: "/private/project/.archcode/skills/broken",
        winner: true,
        shadowed: false,
        valid: false,
        diagnostic: {
          name: "broken",
          source: "project-archcode",
          code: "SKILL_INVALID_PACKAGE",
          message: "Skill package failed validation",
        },
      }],
    });
    fixture.runtime.skillService.projectPromptCatalog.mockResolvedValueOnce({
      includedEntries: [],
      omittedCount: 0,
      renderedText: "- none",
      byteLength: 6,
    });

    const response = await fixture.app.request("/api/projects/project/skills");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      items: [{
        name: "broken",
        source: "project-archcode",
        winner: true,
        shadowed: false,
        valid: false,
        diagnostic: { code: "SKILL_INVALID_PACKAGE", message: "Skill package failed validation" },
      }],
      promptProjection: {
        includedEntries: [],
        omittedCount: 0,
        renderedText: "- none",
        byteLength: 6,
      },
    });
    expect(JSON.stringify(body)).not.toContain("/private/project");
  });

  test("validates the cursor and resolves missing projects through the shared HTTP errors", async () => {
    const fixture = await createFixture();
    const malformed = await fixture.app.request("/api/projects/project/skills?cursor=bad.cursor");
    expect(malformed.status).toBe(400);
    expect(fixture.runtime.skillService.inventoryPage).not.toHaveBeenCalled();

    const emptySession = await fixture.app.request("/api/projects/project/skills?sessionId=%20%20");
    expect(emptySession.status).toBe(400);
    const unknownQuery = await fixture.app.request("/api/projects/project/skills?sessionId=root&unexpected=true");
    expect(unknownQuery.status).toBe(400);
    expect(fixture.runtime.getSessionSkillCatalog).not.toHaveBeenCalled();

    const missing = await fixture.app.request("/api/projects/missing/skills");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: "PROJECT_NOT_FOUND", message: "Project not found: missing" },
    });
  });

  test("returns a stable 400 when a cursor no longer matches the inventory digest", async () => {
    const fixture = await createFixture();
    fixture.runtime.skillService.inventoryPage.mockRejectedValueOnce(Object.assign(
      new Error("Catalog changed or cursor is invalid; restart from the first page"),
      { name: "DigestBoundCursorError", code: "SKILL_INVENTORY_CHANGED" },
    ));
    fixture.runtime.skillService.projectPromptCatalog.mockResolvedValueOnce(promptProjection);

    const response = await fixture.app.request("/api/projects/project/skills?cursor=stale");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "SKILL_INVENTORY_CHANGED",
        message: "Catalog changed or cursor is invalid; restart from the first page",
      },
    });
  });

  test("maps a missing Session inventory scope to the stable Session 404", async () => {
    const fixture = await createFixture();
    fixture.runtime.getSessionSkillCatalog.mockRejectedValueOnce(new SessionFileNotFoundError("missing-session"));

    const response = await fixture.app.request("/api/projects/project/skills?sessionId=missing-session");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "SESSION_NOT_FOUND", message: "Session not found: missing-session" },
    });
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "archcode-skills-route-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const runtime = {
    projectRegistry: {
      get: mock(async (slug: string) => slug === "project"
        ? { slug, name: "Project", workspaceRoot, addedAt: new Date(0).toISOString() }
        : undefined),
    },
    skillService: {
      inventoryPage: mock(async (_workspaceRoot: string, _cursor?: string): Promise<SkillInventoryPage> => ({ items: [] })),
      projectPromptCatalog: mock(async (_workspaceRoot: string): Promise<SkillPromptCatalog> => ({
        includedEntries: [],
        omittedCount: 0,
        renderedText: "- none",
        byteLength: 6,
      })),
    },
    getSessionSkillCatalog: mock(async (
      _workspaceRoot: string,
      _sessionId: string,
      _cursor?: string,
    ): Promise<ProjectSkillInventoryResponse> => ({
      items: [],
      promptProjection: {
        includedEntries: [],
        omittedCount: 0,
        renderedText: "- none",
        byteLength: 6,
      },
    })),
  };

  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/projects", createSkillsRoutes(runtime as unknown as AgentRuntime));
  return { app, runtime, workspaceRoot };
}
