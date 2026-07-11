import { afterEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "./client";
import { fetchCompressionOriginalRange } from "./compression";

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

function successBody(blockRef = "b1") {
  return {
    ok: true,
    blockRef,
    blockId: "block-id",
    status: "active",
    strategy: "dynamic-range",
    trigger: "model_tool_call",
    childBlockRefs: [],
    range: {
      startMessageId: "msg-1",
      endMessageId: "msg-2",
      startRef: "m0001",
      endRef: "m0002",
      startIndex: 0,
      endIndex: 1,
    },
    coveredRefs: ["m0001", "m0002"],
    coveredMessageIds: ["msg-1", "msg-2"],
    messages: [
      {
        ref: "m0001",
        message: {
          id: "msg-1",
          role: "user",
          parts: [{ type: "text", id: "t1", text: "hello", createdAt: 1, completedAt: 2 }],
          createdAt: 1,
          completedAt: 2,
        },
      },
      {
        ref: "m0002",
        message: {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", id: "t2", text: "world", createdAt: 3, completedAt: 4 }],
          createdAt: 3,
          completedAt: 4,
        },
      },
    ],
  };
}

describe("fetchCompressionOriginalRange", () => {
  test("calls the encoded original-range URL and returns the success payload", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "/api/projects/my-slug/sessions/sess-1/compression/b1/original",
      );
      return jsonResponse(successBody("b1"));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchCompressionOriginalRange("my-slug", "sess-1", "b1");

    expect(result.ok).toBe(true);
    expect(result.blockRef).toBe("b1");
    expect(result.strategy).toBe("dynamic-range");
    expect(result.trigger).toBe("model_tool_call");
    expect(result.coveredRefs).toEqual(["m0001", "m0002"]);
    expect(result.messages).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("URL-encodes slug, sessionId, and blockRef", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/api/projects/some%20slug/sessions/s%2Fess/compression/b%231/original");
      return jsonResponse(successBody("b#1"));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchCompressionOriginalRange("some slug", "s/ess", "b#1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("throws ApiError on 404 not_found response", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async () =>
      jsonResponse(
        { ok: false, code: "not_found", reason: "compression_block_not_found", blockRef: "b99" },
        { status: 404 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let caught: unknown;
    try {
      await fetchCompressionOriginalRange("demo", "sess-1", "b99");
      throw new Error("expected fetchCompressionOriginalRange to reject");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).name).toBe("ApiError");
    expect((caught as ApiError).status).toBe(404);
  });

  test("throws ApiError on 422 unsupported response", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async () =>
      jsonResponse(
        { ok: false, code: "unsupported", reason: "missing_hybrid_coverage", blockRef: "b1" },
        { status: 422 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let caught: unknown;
    try {
      await fetchCompressionOriginalRange("demo", "sess-1", "b1");
      throw new Error("expected fetchCompressionOriginalRange to reject");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).name).toBe("ApiError");
    expect((caught as ApiError).status).toBe(422);
  });

  test("throws ApiError instance on non-200 response", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async () =>
      jsonResponse(
        { error: { code: "INTERNAL", message: "boom" } },
        { status: 500 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let caught: unknown;
    try {
      await fetchCompressionOriginalRange("demo", "sess-1", "b1");
      throw new Error("expected fetchCompressionOriginalRange to reject");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
  });
});
