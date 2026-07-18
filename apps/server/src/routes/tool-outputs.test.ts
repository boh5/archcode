import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  ToolOutputError,
  type AgentRuntime,
} from "@archcode/agent-core";
import { createToolOutputRoutes } from "./tool-outputs";
import { errorHandler } from "../error-handler";

const roots: string[] = [];
const OUTPUT_REF = "AAAAAAAAAAAAAAAAAAAAAA";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("tool output HTTP routes", () => {
  test("read and search delegate bounded responses without exposing paths", async () => {
    const fixture = await createFixture();

    const read = await fixture.app.request(
      `/api/projects/project/sessions/child-session/tool-outputs/${OUTPUT_REF}?limit=2`,
    );
    expect(read.status).toBe(200);
    const readBody = await read.json() as Record<string, unknown>;
    expect(JSON.stringify(readBody)).toContain("ERROR_SENTINEL");
    expect(JSON.stringify(readBody)).not.toContain(fixture.workspaceRoot);
    expect(JSON.stringify(readBody)).not.toContain(fixture.artifactRoot);

    const search = await fixture.app.request(
      "/api/projects/project/sessions/child-session/tool-outputs/search",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outputRef: OUTPUT_REF, pattern: "ERROR_SENTINEL" }),
      },
    );
    expect(search.status).toBe(200);
    expect(JSON.stringify(await search.json())).toContain("ERROR_SENTINEL");

    const familySearch = await fixture.app.request(
      "/api/projects/project/sessions/root-session/tool-outputs/search",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern: "TAIL" }),
      },
    );
    expect(familySearch.status).toBe(200);
    expect(JSON.stringify(await familySearch.json())).toContain(OUTPUT_REF);
  });

  test("a ref from another root family is forbidden", async () => {
    const fixture = await createFixture();

    const response = await fixture.app.request(
      `/api/projects/project/sessions/other-session/tool-outputs/${OUTPUT_REF}`,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "TOOL_OUTPUT_FORBIDDEN",
        message: "Tool output is not available to this Session family",
      },
    });
  });

  test("search rejects unknown fields and an oversized body before execution", async () => {
    const fixture = await createFixture();
    let calls = 0;
    fixture.runtime.searchToolOutputs = async () => {
      calls += 1;
      return { matches: [], searchCompleteness: "complete" };
    };

    const unknown = await fixture.app.request(
      "/api/projects/project/sessions/child-session/tool-outputs/search",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern: "x", extra: true }),
      },
    );
    expect(unknown.status).toBe(400);

    const oversized = await fixture.app.request(
      "/api/projects/project/sessions/child-session/tool-outputs/search",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern: "x".repeat(17 * 1024) }),
      },
    );
    expect(oversized.status).toBe(413);
    expect(calls).toBe(0);
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "archcode-tool-output-route-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const artifactRoot = join(root, "artifacts");
  await mkdir(workspaceRoot);
  const runtime = {
    projectRegistry: {
      get: async (slug: string) => slug === "project"
        ? { slug, name: "Project", workspaceRoot, addedAt: new Date(0).toISOString() }
        : undefined,
    },
    readToolOutput: async (_workspaceRoot: string, sessionId: string) => {
      if (sessionId === "other-session") throw new ToolOutputError("TOOL_OUTPUT_FORBIDDEN");
      return {
        outputRef: OUTPUT_REF,
        completeness: "complete" as const,
        records: [{
          segment: "full" as const,
          canonicalStart: 0,
          canonicalEnd: 27,
          text: "ERROR_SENTINEL detail\nTAIL\n",
          continuedFromPrevious: false,
          continuesNext: false,
        }],
      };
    },
    searchToolOutputs: async () => ({
      outputRef: OUTPUT_REF,
      matches: [{
        outputRef: OUTPUT_REF,
        segment: "full" as const,
        canonicalStart: 0,
        canonicalEnd: 14,
        snippet: "ERROR_SENTINEL detail\nTAIL",
      }],
      searchCompleteness: "complete" as const,
    }),
  } as unknown as AgentRuntime;
  const app = new Hono();
  app.onError(errorHandler);
  app.route(
    "/api/projects/:slug/sessions/:sessionId/tool-outputs",
    createToolOutputRoutes(runtime),
  );
  return { app, runtime, workspaceRoot, artifactRoot };
}
