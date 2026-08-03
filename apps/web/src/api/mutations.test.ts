import { afterEach, describe, expect, mock, test } from "bun:test";
import { createSession, deleteSession, invalidateProjectCatalog, invalidateSessionModelSelectionQuery, patchSessionModelSelection, postMessage, removeProjectTodoAttachment, setSessionGoalBudget, stopSessionFamily, uploadProjectTodoAttachment, uploadSessionAttachment } from "./mutations";
import { queryKeys } from "./queries";

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const TEST_PROJECT_SLUG = "test-project";

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
});

describe("project catalog mutation invalidation", () => {
  test("refreshes both the Project Rail and global Home projection", async () => {
    const invalidateQueries = mock(async () => undefined);

    await invalidateProjectCatalog({ invalidateQueries } as never);

    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.projects });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.home });
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("web session runtime mutation API calls", () => {
  const requestedModelSelection = { mode: "session_override" as const, selection: { model: "openai:gpt-5", variant: "deep" } };

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

  test("deleteSession calls the bodyless Session endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/sessions/root-session`);
      expect(init?.method).toBe("DELETE");
      expect(init?.body).toBeUndefined();
      return jsonResponse({ ok: true });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await deleteSession({ slug: TEST_PROJECT_SLUG, sessionId: "root-session" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("setSessionGoalBudget increases or removes the Session-owned budget", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/sessions/root-session/goal/budget`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ tokenBudget: 50_000 });
      return jsonResponse({ sessionId: "root-session" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await setSessionGoalBudget({ slug: TEST_PROJECT_SLUG, sessionId: "root-session", tokenBudget: 50_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("POST messages locks the requested model selection into the request", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/sessions/root-session/messages`);
      expect(JSON.parse(String(init?.body))).toEqual({ text: "Build it", attachmentIds: [], clientRequestId: "11111111-1111-4111-8111-111111111111", requestedModelSelection });
      return jsonResponse({ clientRequestId: "11111111-1111-4111-8111-111111111111", messageId: "message-1", status: "queued" }, { status: 202 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await postMessage({ slug: TEST_PROJECT_SLUG, sessionId: "root-session", content: "Build it", attachmentIds: [], clientRequestId: "11111111-1111-4111-8111-111111111111", requestedModelSelection });
  });

  test("uploads one raw file with its stable attachment id and metadata query", async () => {
    globalThis.document = { cookie: "" } as Document;
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/sessions/root-session/attachments/11111111-1111-4111-8111-111111111111?name=notes.txt&sizeBytes=5`);
      expect(init?.method).toBe("PUT");
      expect(init?.body).toBe(file);
      expect(new Headers(init?.headers).get("Content-Type")).toBe(file.type);
      return jsonResponse({ id: "11111111-1111-4111-8111-111111111111", name: "notes.txt", mediaType: "text/plain", sizeBytes: 5, kind: "file" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(uploadSessionAttachment({
      slug: TEST_PROJECT_SLUG,
      sessionId: "root-session",
      attachmentId: "11111111-1111-4111-8111-111111111111",
      file,
    })).resolves.toMatchObject({ id: "11111111-1111-4111-8111-111111111111", kind: "file" });
  });

  test("uploads a Todo reference with the authoritative expected revision", async () => {
    globalThis.document = { cookie: "" } as Document;
    const file = new File(["hello"], "brief.pdf", { type: "application/pdf" });
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/todos/todo-1/attachments/22222222-2222-4222-8222-222222222222?name=brief.pdf&sizeBytes=5&expectedRevision=7`);
      expect(init?.method).toBe("PUT");
      expect(init?.body).toBe(file);
      expect(new Headers(init?.headers).get("Content-Type")).toBe(file.type);
      return jsonResponse({ todo: { id: "todo-1", revision: 8 }, attachment: { id: "22222222-2222-4222-8222-222222222222", name: "brief.pdf", mediaType: "application/pdf", sizeBytes: 5, kind: "file" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(uploadProjectTodoAttachment({
      slug: TEST_PROJECT_SLUG,
      todoId: "todo-1",
      attachmentId: "22222222-2222-4222-8222-222222222222",
      expectedRevision: 7,
      file,
    })).resolves.toMatchObject({ todo: { revision: 8 }, attachment: { kind: "file" } });
  });

  test("removes a Todo reference with the expected revision body", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/todos/todo-1/attachments/22222222-2222-4222-8222-222222222222`);
      expect(init?.method).toBe("DELETE");
      expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 8 });
      return jsonResponse({ todo: { id: "todo-1", revision: 9 } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(removeProjectTodoAttachment({
      slug: TEST_PROJECT_SLUG,
      todoId: "todo-1",
      attachmentId: "22222222-2222-4222-8222-222222222222",
      expectedRevision: 8,
    })).resolves.toMatchObject({ todo: { revision: 9 } });
  });

  test("PATCH model selection sends optimistic revision and returns complete model state", async () => {
    globalThis.document = { cookie: "" } as Document;
    const response = { modelSelection: { revision: 3, override: requestedModelSelection.selection }, nextModelSelection: { requested: requestedModelSelection, resolved: { selection: requestedModelSelection.selection, providerId: "openai", modelId: "gpt-5", providerDisplayName: "OpenAI", modelDisplayName: "GPT-5", resolution: "session_override" as const, modelRuntimeRevision: "m3" } } };
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/sessions/root-session/model-selection`);
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 2, requestedModelSelection });
      return jsonResponse(response);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(patchSessionModelSelection({ slug: TEST_PROJECT_SLUG, sessionId: "root-session", expectedRevision: 2, requestedModelSelection })).resolves.toEqual(response);
  });

  test("refreshes Session model state after a revision conflict before retry", async () => {
    const invalidateQueries = mock(async () => undefined);

    await invalidateSessionModelSelectionQuery({ invalidateQueries } as never, {
      slug: TEST_PROJECT_SLUG,
      sessionId: "root-session",
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["projects", TEST_PROJECT_SLUG, "sessions", "root-session"],
    });
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
