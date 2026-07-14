import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

import {
  HitlConflictError,
  HitlNotFoundError,
  type AgentRuntime,
} from "@archcode/agent-core";

import { errorHandler } from "../error-handler";
import { createHitlRoutes } from "./hitl";

function createApp(overrides: Partial<AgentRuntime>): Hono {
  const project = {
    slug: "demo",
    name: "Demo",
    workspaceRoot: import.meta.dir,
    createdAt: 1,
    lastOpenedAt: 1,
  };
  const runtime = {
    projectRegistry: {
      get: mock(async (slug: string) => slug === project.slug ? project : undefined),
    },
    ...overrides,
  } as unknown as AgentRuntime;
  const app = new Hono();
  app.route("/api/projects", createHitlRoutes(runtime));
  app.onError(errorHandler);
  return app;
}

describe("HITL routes", () => {
  test("maps a missing mutation target to 404", async () => {
    const app = createApp({
      respondToHitl: mock(async () => {
        throw new HitlNotFoundError("missing");
      }),
    });

    const response = await app.request("/api/projects/demo/hitl/missing/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "question_answer", answers: ["yes"] }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "HITL_NOT_FOUND", message: "HITL missing was not found" },
    });
  });

  test("maps an immutable response conflict to 409", async () => {
    const app = createApp({
      cancelHitl: mock(async () => {
        throw new HitlConflictError("hitl-1", "Cannot replace an accepted HITL response");
      }),
    });

    const response = await app.request("/api/projects/demo/hitl/hitl-1/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "stop" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "Cannot replace an accepted HITL response" },
    });
  });
});
