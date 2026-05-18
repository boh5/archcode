import { afterEach, describe, expect, mock, test } from "bun:test";
import { WebFetchInputSchema, validateUrl, runWebFetch, webFetchTool } from "./web-fetch";
import { createRegistry } from "../registry";
import type { ToolExecutionContext } from "../types";
import { createTestProjectContext } from "../test-project-context";

// ─── Helpers ───

function mockCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    store: {} as any,
    toolName: "web_fetch",
    toolCallId: "call_test",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["web_fetch"]),
    workspaceRoot: process.cwd(),
    projectContext: createTestProjectContext(process.cwd()),
    ...overrides,
  };
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><title>Test Page</title></head>
<body>
  <article>
    <h1>Hello World</h1>
    <p>This is a test article with <strong>bold text</strong> and a <a href="/link">link</a>.</p>
    <ul><li>Item 1</li><li>Item 2</li></ul>
  </article>
</body>
</html>`;

const JSON_RESPONSE = JSON.stringify({ message: "hello", count: 42 });

function mockFetchResponse(body: string, options: { status?: number; contentType?: string; headers?: Record<string, string> } = {}) {
  const { status = 200, contentType = "text/html; charset=utf-8", headers = {} } = options;
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      ...headers,
    },
  });
}

// ─── URL Validation ───

describe("validateUrl", () => {
  test("accepts valid https URL", () => {
    const result = validateUrl("https://example.com/path");
    expect(result.url).toBe("https://example.com/path");
    expect(result.originalUrl).toBe("https://example.com/path");
  });

  test("accepts valid http URL and upgrades to https", () => {
    const result = validateUrl("http://example.com");
    expect(result.url).toBe("https://example.com/");
    expect(result.originalUrl).toBe("http://example.com/");
  });

  test("rejects non-http protocols", () => {
    expect(() => validateUrl("ftp://example.com")).toThrow("Unsupported URL scheme");
    expect(() => validateUrl("file:///tmp/test")).toThrow("Unsupported URL scheme");
    expect(() => validateUrl("javascript:alert(1)")).toThrow("Unsupported URL scheme");
  });

  test("rejects URLs with credentials", () => {
    expect(() => validateUrl("https://user:pass@example.com")).toThrow("credentials");
  });

  test("rejects overly long URLs", () => {
    const longUrl = "https://example.com/" + "a".repeat(3000);
    expect(() => validateUrl(longUrl)).toThrow("maximum length");
  });

  test("rejects malformed URLs", () => {
    expect(() => validateUrl("")).toThrow("Invalid URL");
    expect(() => validateUrl("not a url")).toThrow("Invalid URL");
  });
});

// ─── Input Schema ───

describe("WebFetchInputSchema", () => {
  test("accepts valid input with defaults", () => {
    const result = WebFetchInputSchema.safeParse({ url: "https://example.com" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBe("https://example.com");
      expect(result.data.format).toBe("markdown");
      expect(result.data.maxLength).toBe(50_000);
    }
  });

  test("accepts custom format and maxLength", () => {
    const result = WebFetchInputSchema.safeParse({
      url: "https://example.com",
      format: "text",
      maxLength: 10_000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.format).toBe("text");
      expect(result.data.maxLength).toBe(10_000);
    }
  });

  test("rejects extra fields", () => {
    const result = WebFetchInputSchema.safeParse({
      url: "https://example.com",
      extra: true,
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid format", () => {
    const result = WebFetchInputSchema.safeParse({
      url: "https://example.com",
      format: "xml",
    });
    expect(result.success).toBe(false);
  });

  test("rejects maxLength out of range", () => {
    const tooSmall = WebFetchInputSchema.safeParse({
      url: "https://example.com",
      maxLength: 500,
    });
    expect(tooSmall.success).toBe(false);

    const tooLarge = WebFetchInputSchema.safeParse({
      url: "https://example.com",
      maxLength: 1_000_000,
    });
    expect(tooLarge.success).toBe(false);
  });
});

// ─── Fetch Integration via Registry ───

describe("webFetchTool via registry", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("schema validates input through registry", async () => {
    const registry = createRegistry([webFetchTool]);
    const result = await registry.execute(
      { toolName: "web_fetch", toolCallId: "bad", input: { url: "", extra: true } },
      mockCtx(),
    );
    expect(result.isError).toBe(true);
  });

  test("invalid URL returns error", async () => {
    const registry = createRegistry([webFetchTool]);
    const result = await registry.execute(
      { toolName: "web_fetch", toolCallId: "bad-url", input: { url: "ftp://bad" } },
      mockCtx(),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.kind).toBe("webfetch-invalid-url");
  });

  test("successful HTML fetch returns markdown by default", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(mockFetchResponse(HTML_PAGE)),
    ) as unknown as typeof globalThis.fetch;

    const result = await runWebFetch(
      { url: "https://example.com", format: "markdown", maxLength: 50_000 },
      mockCtx(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("<fetch-result>");
    expect(result.output).toContain("<url>https://example.com/</url>");
    expect(result.output).toContain("<status>200</status>");
    expect(result.output).toContain("Hello World");
  });

  test("HTML fetch with text format returns plain text", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(mockFetchResponse(HTML_PAGE)),
    ) as unknown as typeof globalThis.fetch;

    const result = await runWebFetch(
      { url: "https://example.com", format: "text", maxLength: 50_000 },
      mockCtx(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Hello World");
    expect(result.output).toContain("bold text");
  });

  test("HTML fetch with html format returns raw HTML", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(mockFetchResponse(HTML_PAGE)),
    ) as unknown as typeof globalThis.fetch;

    const result = await runWebFetch(
      { url: "https://example.com", format: "html", maxLength: 50_000 },
      mockCtx(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("<!DOCTYPE html>");
    expect(result.output).toContain("<h1>Hello World</h1>");
  });

  test("JSON response is returned as-is", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(mockFetchResponse(JSON_RESPONSE, { contentType: "application/json" })),
    ) as unknown as typeof globalThis.fetch;

    const result = await runWebFetch(
      { url: "https://api.example.com/data", format: "markdown", maxLength: 50_000 },
      mockCtx(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('"message":"hello"');
  });

  test("text/plain response is returned as-is", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(mockFetchResponse("Hello plain text", { contentType: "text/plain" })),
    ) as unknown as typeof globalThis.fetch;

    const result = await runWebFetch(
      { url: "https://example.com/readme.txt", format: "markdown", maxLength: 50_000 },
      mockCtx(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Hello plain text");
  });

  test("unsupported content type returns error", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        mockFetchResponse("binary data", { contentType: "application/pdf" }),
      ),
    ) as unknown as typeof globalThis.fetch;

    const result = await runWebFetch(
      { url: "https://example.com/doc.pdf", format: "markdown", maxLength: 50_000 },
      mockCtx(),
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.kind).toBe("webfetch-content-type-unsupported");
  });

  test("HTTP error status still returns content", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        mockFetchResponse("<html><body><h1>Not Found</h1><p>The page was not found.</p></body></html>", {
          status: 404,
          contentType: "text/html",
        }),
      ),
    ) as unknown as typeof globalThis.fetch;

    const result = await runWebFetch(
      { url: "https://example.com/missing", format: "markdown", maxLength: 50_000 },
      mockCtx(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("<status>404</status>");
    expect(result.output).toContain("Not Found");
  });

  test("content is truncated beyond maxLength", async () => {
    const longPage = `<!DOCTYPE html><html><body><p>${"x".repeat(1000)}</p></body></html>`;
    globalThis.fetch = mock(() =>
      Promise.resolve(mockFetchResponse(longPage)),
    ) as unknown as typeof globalThis.fetch;

    const result = await runWebFetch(
      { url: "https://example.com/long", format: "html", maxLength: 500 },
      mockCtx(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("[Output truncated: content exceeded maxLength]");
  });

  test("timeout returns timeout error", async () => {
    globalThis.fetch = mock(() =>
      new Promise((_, reject) => {
        setTimeout(() => reject(new DOMException("Aborted", "AbortError")), 50);
      }),
    ) as unknown as typeof globalThis.fetch;

    // Use a very short timeout by overriding the constant indirectly
    // Since we can't easily override DEFAULT_TIMEOUT_MS, test with AbortController
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 5);

    const result = await runWebFetch(
      { url: "https://example.com/slow", format: "markdown", maxLength: 50_000 },
      mockCtx({ abort: abortController.signal }),
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.kind).toBe("cancelled");
  });

  test("redirects are followed with URL validation", async () => {
    let callCount = 0;
    globalThis.fetch = mock((url: string, opts: any) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 301,
            headers: { location: "https://example.com/final" },
          }),
        );
      }
      return Promise.resolve(mockFetchResponse(HTML_PAGE));
    }) as unknown as typeof globalThis.fetch;

    const result = await runWebFetch(
      { url: "https://example.com/redirect", format: "markdown", maxLength: 50_000 },
      mockCtx(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("<url>https://example.com/final</url>");
    expect(callCount).toBe(2);
  });

  test("redirect to invalid URL is rejected", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "ftp://malicious.com" },
        }),
      ),
    ) as unknown as typeof globalThis.fetch;

    const result = await runWebFetch(
      { url: "https://example.com/bad-redirect", format: "markdown", maxLength: 50_000 },
      mockCtx(),
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.kind).toBe("webfetch-invalid-url");
  });

  test("tool traits are correct", () => {
    expect(webFetchTool.traits).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
  });
});
