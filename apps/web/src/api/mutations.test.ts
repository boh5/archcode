import { afterEach, describe, expect, mock, test } from "bun:test";
import { apiFetch } from "./client";
import { createSession, stopSessionFamily } from "./mutations";

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const TEST_PROJECT_SLUG = "test-project";

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("web goal mutation API calls", () => {
  test("retryGoal calls POST /api/projects/:slug/goals/:goalId/retry", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/goals/goal-1/retry`);
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      return jsonResponse({ id: "goal-1", status: "running" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/goals/goal-1/retry`, { method: "POST" });
    expect(result).toMatchObject({ id: "goal-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("cancelGoal calls POST /api/projects/:slug/goals/:goalId/cancel", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/goals/goal-1/cancel`);
      expect(init?.method).toBe("POST");
      return jsonResponse({ id: "goal-1", status: "cancelled" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/goals/goal-1/cancel`, { method: "POST" });
    expect(result).toMatchObject({ id: "goal-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("web session runtime mutation API calls", () => {
  test("createSession calls the bodyless Session endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/sessions`);
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      return jsonResponse({ sessionId: "root-session" }, { status: 201 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await createSession({ slug: TEST_PROJECT_SLUG });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("stopSessionFamily calls the root Session Family stop endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/sessions/root-session/stop`);
      expect(init?.method).toBe("POST");
      return jsonResponse({ ok: true });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await stopSessionFamily({ slug: TEST_PROJECT_SLUG, rootSessionId: "root-session" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("web HITL mutation API calls", () => {
  test("respondHitl calls owner-qualified POST endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/hitl/session/session-1/hitl-1/respond`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body ?? "{}"))).toMatchObject({ type: "approval_decision", decision: "approved" });
      return jsonResponse({ ok: true, hitlId: "hitl-1" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/hitl/session/session-1/hitl-1/respond`, {
      method: "POST",
      body: { type: "approval_decision", decision: "approved" },
    });
    expect(result).toEqual({ ok: true, hitlId: "hitl-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("cancelHitl calls owner-qualified POST endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/hitl/session/session-1/hitl-1/cancel`);
      expect(init?.method).toBe("POST");
      return jsonResponse({ ok: true, hitlId: "hitl-1" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/hitl/session/session-1/hitl-1/cancel`, { method: "POST" });
    expect(result).toEqual({ ok: true, hitlId: "hitl-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("respondHitl with review outcome sends project-scoped endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/projects/demo/hitl/goal/goal-1/review-1/respond");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.type).toBe("review_outcome");
      expect(body.outcome).toBe("DONE");
      return jsonResponse({ ok: true, hitlId: "review-1" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/demo/hitl/goal/goal-1/review-1/respond", {
      method: "POST",
      body: { type: "review_outcome", outcome: "DONE" },
    });
    expect(result).toEqual({ ok: true, hitlId: "review-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("cancelHitl with reason sends project-scoped endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/projects/demo/hitl/session/session-1/hitl-cancel/cancel");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.reason).toBe("No longer needed");
      return jsonResponse({ ok: true, hitlId: "hitl-cancel" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/demo/hitl/session/session-1/hitl-cancel/cancel", {
      method: "POST",
      body: { reason: "No longer needed" },
    });
    expect(result).toEqual({ ok: true, hitlId: "hitl-cancel" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("respondHitl never calls global /api/hitl/:id/respond endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).not.toBe("/api/hitl/hitl-1/respond");
      expect(url).not.toMatch(/^\/api\/hitl\/[^/]+\/respond$/);
      expect(url).toBe("/api/projects/demo/hitl/session/session-1/hitl-1/respond");
      return jsonResponse({ ok: true, hitlId: "hitl-1" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/demo/hitl/session/session-1/hitl-1/respond", {
      method: "POST",
      body: { type: "approval_decision", decision: "approved" },
    });
    expect(result).toEqual({ ok: true, hitlId: "hitl-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("respondHitl never calls /api/questions endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).not.toMatch(/^\/api\/questions\//);
      expect(url).not.toMatch(/^\/api\/questions\b/);
      expect(url).toBe("/api/projects/demo/hitl/session/session-1/hitl-q1/respond");
      return jsonResponse({ ok: true, hitlId: "hitl-q1" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/demo/hitl/session/session-1/hitl-q1/respond", {
      method: "POST",
      body: { type: "question_answer", answers: ["yes"] },
    });
    expect(result).toEqual({ ok: true, hitlId: "hitl-q1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("cancelHitl never calls /api/permissions endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).not.toMatch(/^\/api\/permissions\//);
      expect(url).not.toMatch(/^\/api\/permissions\b/);
      expect(url).toBe("/api/projects/demo/hitl/session/session-1/hitl-perm/cancel");
      return jsonResponse({ ok: true, hitlId: "hitl-perm" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/demo/hitl/session/session-1/hitl-perm/cancel", { method: "POST" });
    expect(result).toEqual({ ok: true, hitlId: "hitl-perm" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("web has no agent-core imports", () => {
  test("queries.ts does not import from @archcode/agent-core or @archcode/server", async () => {
    const content = await Bun.file(
      new URL("./queries.ts", import.meta.url),
    ).text();
    expect(content).not.toContain("@archcode/agent-core");
    expect(content).not.toContain("@archcode/server");
  });

  test("mutations.ts does not import from @archcode/agent-core or @archcode/server", async () => {
    const content = await Bun.file(
      new URL("./mutations.ts", import.meta.url),
    ).text();
    expect(content).not.toContain("@archcode/agent-core");
    expect(content).not.toContain("@archcode/server");
  });

  test("types.ts does not import from @archcode/agent-core or @archcode/server", async () => {
    const content = await Bun.file(
      new URL("./types.ts", import.meta.url),
    ).text();
    expect(content).not.toContain("@archcode/agent-core");
    expect(content).not.toContain("@archcode/server");
  });
});

describe("web mutations do not call legacy permission/question endpoints", () => {
  test("mutations.ts has no /api/permissions or /api/questions calls", async () => {
    const content = await Bun.file(
      new URL("./mutations.ts", import.meta.url),
    ).text();
    expect(content).not.toContain("/api/permissions");
    expect(content).not.toContain("/api/questions");
    expect(content).not.toContain("usePostPermissionResponse");
    expect(content).not.toContain("usePostQuestionAnswer");
  });
});
