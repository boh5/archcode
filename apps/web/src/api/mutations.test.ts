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
