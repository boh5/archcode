import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionSummary, SessionTreeResponse } from "@specra/protocol";
import { sessionTreeQueryOptions, sessionsQueryOptions } from "./queries";

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
});
