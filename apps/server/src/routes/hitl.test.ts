import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

import {
  HitlConflictError,
  HitlBoundaryCodec,
  HitlNotFoundError,
  SecretRedactionPolicy,
  type AgentRuntime,
} from "@archcode/agent-core";

import { errorHandler } from "../error-handler";
import { createHitlRoutes } from "./hitl";

const TEST_SECRET = "http-hitl-secret-123456";

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
    contextResolver: {
      resolve: mock(async () => ({
        hitl: { codec: new HitlBoundaryCodec(new SecretRedactionPolicy([TEST_SECRET])) },
      })),
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

  test("maps forged approve always for an ineligible request to 409", async () => {
    const respondToHitl = mock(async () => {
      throw new HitlConflictError("hitl-1", "This permission request is not eligible for persistent approval");
    });
    const app = createApp({ respondToHitl });

    const response = await app.request("/api/projects/demo/hitl/hitl-1/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "permission_decision", decision: "approve_always" }),
    });

    expect(response.status).toBe(409);
    expect(respondToHitl).toHaveBeenCalledTimes(1);
  });

  test("redacts a secret response before handing it to runtime", async () => {
    const respondToHitl = mock(async (input: { response: unknown }) => ({
      hitlId: "hitl-1",
      status: "answered",
      view: {},
      response: input.response,
    }));
    const app = createApp({ respondToHitl: respondToHitl as never });

    const response = await app.request("/api/projects/demo/hitl/hitl-1/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "question_answer", answers: [`Use ${TEST_SECRET}`] }),
    });

    expect(response.status).toBe(200);
    const forwarded = JSON.stringify(respondToHitl.mock.calls[0]?.[0]);
    expect(forwarded).not.toContain(TEST_SECRET);
    expect(forwarded).toContain("[REDACTED:SECRET]");
  });

  test("rejects an oversized body before runtime mutation", async () => {
    const respondToHitl = mock(async () => {
      throw new Error("must not be called");
    });
    const app = createApp({ respondToHitl });

    const response = await app.request("/api/projects/demo/hitl/hitl-1/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "question_answer", answers: ["x".repeat(129 * 1024)] }),
    });

    expect(response.status).toBe(413);
    expect(respondToHitl).not.toHaveBeenCalled();
  });
});
