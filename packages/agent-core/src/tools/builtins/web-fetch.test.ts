import { afterEach, describe, expect, mock, test } from "bun:test";
import { storeManager } from "../../store/store";
import { WebFetchInputSchema, validateUrl, runWebFetch, webFetchTool } from "./web-fetch";
import type { ToolExecutionContext } from "../types";
import { createTestProjectContext } from "../test-project-context";

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  const workspaceRoot = import.meta.dir;
  return { store: {} as never, toolName: "web_fetch", toolCallId: "call", input: {}, step: 1, abort: new AbortController().signal, startedAt: Date.now(), allowedTools: new Set(["web_fetch"]), cwd: workspaceRoot, storeManager, projectContext: createTestProjectContext(workspaceRoot), ...overrides };
}

function text(result: Awaited<ReturnType<typeof runWebFetch>>): string {
  return result.draft.kind === "text" ? result.draft.text : "";
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("web fetch output boundary", () => {
  test("removes maxLength from the strict public schema", () => {
    expect(WebFetchInputSchema.safeParse({ url: "https://example.com" }).success).toBe(true);
    expect(WebFetchInputSchema.safeParse({ url: "https://example.com", maxLength: 1_000 }).success).toBe(false);
  });

  test("returns complete extracted content for finalization instead of producer truncation", async () => {
    const body = `<html><body><article><h1>Heading</h1><p>${"x".repeat(80_000)}</p></article></body></html>`;
    globalThis.fetch = mock(() => Promise.resolve(new Response(body, { headers: { "content-type": "text/html" } }))) as unknown as typeof fetch;
    const result = await runWebFetch({ url: "https://example.com", format: "markdown" }, context());
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("Heading");
    expect(text(result)).toContain("x".repeat(80_000));
    expect(text(result)).not.toContain("maxLength");
  });

  test("rejects a declared body larger than the fixed 5 MiB pre-parse limit", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("ignored", { headers: { "content-type": "text/plain", "content-length": String(5 * 1024 * 1024 + 1) } }))) as unknown as typeof fetch;
    const result = await runWebFetch({ url: "https://example.com", format: "text" }, context());
    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_WEBFETCH_SIZE_EXCEEDED");
  });

  test("reads a no-content-length body delivered as one-byte chunks", async () => {
    const bytes = new TextEncoder().encode("one-byte-stream");
    let index = 0;
    globalThis.fetch = mock(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(index, ++index));
      },
    }), { headers: { "content-type": "text/plain" } }))) as unknown as typeof fetch;

    const result = await runWebFetch({ url: "https://example.com", format: "text" }, context());

    expect(result.isError).toBe(false);
    expect(text(result)).toContain("one-byte-stream");
  });

  test("cancels a streamed body immediately after the fixed 5 MiB pre-parse cap", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    let emitted = 0;
    let cancelled = 0;
    globalThis.fetch = mock(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() { cancelled += 1; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/plain" } }))) as unknown as typeof fetch;

    const result = await runWebFetch({ url: "https://example.com", format: "text" }, context());

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_WEBFETCH_SIZE_EXCEEDED");
    expect(emitted).toBe(5 * 1024 * 1024 + chunk.byteLength);
    expect(cancelled).toBe(1);
  });

  test("keeps URL security validation", () => {
    expect(validateUrl("http://example.com").url).toBe("https://example.com/");
    expect(() => validateUrl("ftp://example.com")).toThrow("Unsupported URL scheme");
    expect(() => validateUrl("https://user:pass@example.com")).toThrow("credentials");
    expect(() => validateUrl("not a URL")).toThrow("Invalid URL");
    expect(() => validateUrl(`https://example.com/${"x".repeat(2_048)}`)).toThrow("maximum length");
  });

  test("preserves the selected HTML, text, and JSON content formats before finalization", async () => {
    const html = "<html><body><article><h1>Title</h1><p>Body</p></article></body></html>";
    globalThis.fetch = mock(() => Promise.resolve(new Response(html, { headers: { "content-type": "text/html" } }))) as unknown as typeof fetch;
    expect(text(await runWebFetch({ url: "https://example.com", format: "html" }, context()))).toContain("<h1>Title</h1>");

    globalThis.fetch = mock(() => Promise.resolve(new Response("plain body", { headers: { "content-type": "text/plain" } }))) as unknown as typeof fetch;
    expect(text(await runWebFetch({ url: "https://example.com", format: "text" }, context()))).toContain("plain body");

    globalThis.fetch = mock(() => Promise.resolve(new Response('{"ok":true}', { headers: { "content-type": "application/json" } }))) as unknown as typeof fetch;
    expect(text(await runWebFetch({ url: "https://example.com", format: "markdown" }, context()))).toContain('{"ok":true}');
  });

  test("follows safe redirects but rejects unsafe targets", async () => {
    const calls: string[] = [];
    globalThis.fetch = mock((url: string) => {
      calls.push(url);
      return Promise.resolve(calls.length === 1
        ? new Response(null, { status: 302, headers: { location: "/final" } })
        : new Response("final", { headers: { "content-type": "text/plain" } }));
    }) as unknown as typeof fetch;
    const followed = await runWebFetch({ url: "https://example.com/start", format: "text" }, context());
    expect(text(followed)).toContain("https://example.com/final");
    expect(calls).toEqual(["https://example.com/start", "https://example.com/final"]);

    globalThis.fetch = mock(() => Promise.resolve(new Response(null, { status: 302, headers: { location: "ftp://example.com" } }))) as unknown as typeof fetch;
    const rejected = await runWebFetch({ url: "https://example.com/start", format: "text" }, context());
    expect(rejected.details?.error?.code).toBe("TOOL_WEBFETCH_INVALID_URL");
  });

  test("keeps artifact output policy", () => {
    expect(webFetchTool.outputPolicy).toEqual({ kind: "artifact", previewDirection: "head-tail" });
  });
});
