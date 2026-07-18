import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "./client";
import {
  classifyToolOutputError,
  isTerminalToolOutputError,
  readToolOutput,
  searchToolOutput,
} from "./tool-outputs";

const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => (
  new Response(JSON.stringify({}), { status: 200 })
));

beforeEach(() => {
  fetchMock.mockReset();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
});

describe("tool output API", () => {
  test("URL-encodes the fixed read route and sends only bounded paging fields", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      outputRef: "abcdefghijklmnopqrstuv",
      completeness: "complete",
      records: [],
    }), { status: 200 }));

    await readToolOutput({
      projectSlug: "my project",
      sessionId: "root/session",
      outputRef: "abcdefghijklmnopqrstuv",
      cursor: "next_cursor",
      limit: 200,
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("/api/projects/my%20project/sessions/root%2Fsession/tool-outputs/abcdefghijklmnopqrstuv?cursor=next_cursor&limit=200");
    expect(init?.method).toBeUndefined();
  });

  test("uses the fixed search route with an explicit artifact ref and cursor", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      outputRef: "abcdefghijklmnopqrstuv",
      matches: [],
      searchCompleteness: "complete",
    }), { status: 200 }));

    await searchToolOutput({
      projectSlug: "demo",
      sessionId: "root-1",
      outputRef: "abcdefghijklmnopqrstuv",
      pattern: "needle",
      cursor: "match_cursor",
      limit: 50,
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("/api/projects/demo/sessions/root-1/tool-outputs/search");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      outputRef: "abcdefghijklmnopqrstuv",
      pattern: "needle",
      cursor: "match_cursor",
      limit: 50,
    });
  });

  test("classifies expired, evicted, and not-found as terminal", () => {
    for (const code of ["TOOL_OUTPUT_EXPIRED", "TOOL_OUTPUT_EVICTED", "TOOL_OUTPUT_NOT_FOUND"] as const) {
      const error = new ApiError({ code, message: code, status: 410 });
      expect(classifyToolOutputError(error)).toBe(code);
      expect(isTerminalToolOutputError(error)).toBe(true);
    }
    expect(isTerminalToolOutputError(new ApiError({ code: "TOOL_OUTPUT_UNAVAILABLE", message: "busy", status: 503 }))).toBe(false);
  });
});
