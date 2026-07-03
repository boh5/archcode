import { afterEach, describe, expect, mock, test } from "bun:test";
import { apiFetch } from "./client";

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;

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
  test("createGoal calls POST /api/projects/:slug/goals", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/projects/archcode/goals");
      expect(init?.method).toBe("POST");
      return jsonResponse({ id: "goal-new", title: "New Goal" }, { status: 201 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/archcode/goals", {
      method: "POST",
      body: { title: "New Goal", doneConditions: [], retryPolicy: { maxRetries: 3, backoffMs: 5000, escalateOnFailure: true }, approvalPoints: [], reviewerAgent: "reviewer", author: "user" },
    });

    expect(result).toMatchObject({ id: "goal-new" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("lockGoal calls POST /api/projects/:slug/goals/:goalId/lock", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/projects/archcode/goals/goal-1/lock");
      expect(init?.method).toBe("POST");
      return jsonResponse({ id: "goal-1", status: "locked" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/archcode/goals/goal-1/lock", {
      method: "POST",
      body: { lockedBy: "user" },
    });

    expect(result).toMatchObject({ id: "goal-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("runGoal calls POST /api/projects/:slug/goals/:goalId/run", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/projects/archcode/goals/goal-1/run");
      expect(init?.method).toBe("POST");
      return jsonResponse({ id: "goal-1", status: "running" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/archcode/goals/goal-1/run", { method: "POST", body: {} });
    expect(result).toMatchObject({ id: "goal-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("retryGoal calls POST /api/projects/:slug/goals/:goalId/retry", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/projects/archcode/goals/goal-1/retry");
      expect(init?.method).toBe("POST");
      return jsonResponse({ id: "goal-1", status: "running" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/archcode/goals/goal-1/retry", { method: "POST", body: {} });
    expect(result).toMatchObject({ id: "goal-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("escalateGoal calls POST /api/projects/:slug/goals/:goalId/escalate", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/projects/archcode/goals/goal-1/escalate");
      expect(init?.method).toBe("POST");
      return jsonResponse({ id: "goal-1", status: "escalated" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/archcode/goals/goal-1/escalate", { method: "POST" });
    expect(result).toMatchObject({ id: "goal-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("cancelGoal calls POST /api/projects/:slug/goals/:goalId/cancel", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/projects/archcode/goals/goal-1/cancel");
      expect(init?.method).toBe("POST");
      return jsonResponse({ id: "goal-1", status: "paused" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/archcode/goals/goal-1/cancel", { method: "POST" });
    expect(result).toMatchObject({ id: "goal-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("web HITL mutation API calls", () => {
  test("respondHitl calls POST /api/projects/:slug/hitl/:id/respond", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/projects/archcode/hitl/hitl-1/respond");
      expect(init?.method).toBe("POST");
      return jsonResponse({ ok: true, hitlId: "hitl-1" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/archcode/hitl/hitl-1/respond", {
      method: "POST",
      body: { decision: "approved" },
    });
    expect(result).toEqual({ ok: true, hitlId: "hitl-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("cancelHitl calls POST /api/projects/:slug/hitl/:id/cancel", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/projects/archcode/hitl/hitl-1/cancel");
      expect(init?.method).toBe("POST");
      return jsonResponse({ ok: true, hitlId: "hitl-1" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/archcode/hitl/hitl-1/cancel", { method: "POST" });
    expect(result).toEqual({ ok: true, hitlId: "hitl-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("respondHitl with review outcome sends project-scoped endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/projects/demo/hitl/review-1/respond");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.outcome).toBe("DONE");
      return jsonResponse({ ok: true, hitlId: "review-1" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/demo/hitl/review-1/respond", {
      method: "POST",
      body: { outcome: "DONE" },
    });
    expect(result).toEqual({ ok: true, hitlId: "review-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("cancelHitl with reason sends project-scoped endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/projects/demo/hitl/hitl-cancel/cancel");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.reason).toBe("No longer needed");
      return jsonResponse({ ok: true, hitlId: "hitl-cancel" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/demo/hitl/hitl-cancel/cancel", {
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
      expect(url).toBe("/api/projects/demo/hitl/hitl-1/respond");
      return jsonResponse({ ok: true, hitlId: "hitl-1" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/demo/hitl/hitl-1/respond", {
      method: "POST",
      body: { decision: "approved" },
    });
    expect(result).toEqual({ ok: true, hitlId: "hitl-1" });
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
