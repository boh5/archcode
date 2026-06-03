import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionSummary, SessionTreeResponse, WorkflowState } from "@specra/protocol";
import { focusedSessionQueryOptions, queryKeys, sessionTreeQueryOptions, sessionsQueryOptions, workflowQueryOptions } from "./queries";

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
type QueryOptionWithFn<T> = { queryFn: (context?: unknown) => Promise<T> };

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

describe("web session query contracts", () => {
  test("sessionsQueryOptions normalizes identity fields and preserves root-only server list", async () => {
    globalThis.document = { cookie: "" } as Document;
    const rootSession: SessionSummary = {
      sessionId: "root-session",
      rootSessionId: "root-session",
      workflowId: "workflow-root",
      title: "Root",
      createdAt: 1_000,
      lastUpdatedAt: 2_000,
    };
    const childSession: SessionSummary = {
      sessionId: "child-session",
      rootSessionId: "root-session",
      parentSessionId: "root-session",
      title: "Child",
      createdAt: 1_500,
      lastUpdatedAt: 1_700,
    };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/projects/specra/sessions");
      return jsonResponse({ sessions: [rootSession, childSession] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await (sessionsQueryOptions("specra") as unknown as QueryOptionWithFn<unknown[]>).queryFn();

    expect(result).toEqual([
      {
        id: "root-session",
        sessionId: "root-session",
        rootSessionId: "root-session",
        parentSessionId: undefined,
        workflowId: "workflow-root",
        title: "Root",
        createdAt: 1_000,
        updatedAt: 2_000,
        lastUpdatedAt: 2_000,
      },
      {
        id: "child-session",
        sessionId: "child-session",
        rootSessionId: "root-session",
        parentSessionId: "root-session",
        title: "Child",
        createdAt: 1_500,
        updatedAt: 1_700,
        lastUpdatedAt: 1_700,
      },
    ]);
  });

  test("focusedSessionQueryOptions fetches a single child session and normalizes identity", async () => {
    globalThis.document = { cookie: "" } as Document;
    const serverResponse = {
      sessionId: "child-session",
      rootSessionId: "root-session",
      parentSessionId: "root-session",
      title: "Focused Child",
      createdAt: 1_000,
      lastUpdatedAt: 2_000,
    };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/projects/specra/sessions/child-session");
      return jsonResponse(serverResponse);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await (focusedSessionQueryOptions("specra", "child-session") as unknown as QueryOptionWithFn<unknown>).queryFn();

    expect(result).toMatchObject({
      id: "child-session",
      sessionId: "child-session",
      rootSessionId: "root-session",
      title: "Focused Child",
      createdAt: 1_000,
      updatedAt: 2_000,
      lastUpdatedAt: 2_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("focusedSessionQueryOptions is disabled when focusSessionId is null", () => {
    const opts = focusedSessionQueryOptions("specra", null);
    expect(opts.enabled).toBe(false);
  });

  test("sessionTreeQueryOptions fetches the root tree endpoint and returns child identity", async () => {
    globalThis.document = { cookie: "" } as Document;
    const tree: SessionTreeResponse = {
      root: {
        session: { sessionId: "root-session", rootSessionId: "root-session", title: "Root", createdAt: 1_000 },
        children: [
          {
            session: {
              sessionId: "child-session",
              rootSessionId: "root-session",
              parentSessionId: "root-session",
              title: "Child",
              createdAt: 2_000,
            },
            children: [],
          },
        ],
      },
      diagnostics: [],
    };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/projects/specra/sessions/root-session/tree");
      return jsonResponse(tree);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await (sessionTreeQueryOptions("specra", "root-session") as unknown as QueryOptionWithFn<SessionTreeResponse>).queryFn();

    expect(result.root.children[0].session).toMatchObject({
      sessionId: "child-session",
      rootSessionId: "root-session",
      parentSessionId: "root-session",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("workflowQueryOptions fetches the canonical workflow endpoint by workflowId", async () => {
    globalThis.document = { cookie: "" } as Document;
    const workflow: WorkflowState = {
      id: "workflow-123",
      type: "full_feature",
      stage: "product_drafting",
      status: "active",
      sessionIds: { orchestrator: "session-1" },
    };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/projects/specra/workflows/workflow-123");
      return jsonResponse({ workflow });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = workflowQueryOptions("specra", "workflow-123");
    const result = await (opts as unknown as QueryOptionWithFn<WorkflowState>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", "specra", "workflows", "workflow-123"]);
    expect(result).toEqual(workflow);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("queryKeys.workflow is keyed by workflowId", () => {
    expect(queryKeys.workflow("specra", "workflow-abc")).toEqual([
      "projects",
      "specra",
      "workflows",
      "workflow-abc",
    ]);
  });
});
