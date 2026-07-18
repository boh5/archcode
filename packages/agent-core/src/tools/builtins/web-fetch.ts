import { z } from "zod";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "@truto/turndown-plugin-gfm";
import type { Logger } from "../../logger";
import { silentLogger } from "../../logger";
import { defineTool } from "../define-tool";
import type { RawToolResult, ToolExecutionContext } from "../types";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import { BoundedByteBuffer } from "../../utils/bounded-byte-buffer";

// ─── Module-level logger ───

let _logger: Logger = silentLogger;

export function configureDefaultWebFetchLogger(logger: Logger): void {
  _logger = logger;
}

// ─── Constants ───

const MAX_URL_LENGTH = 2048;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ─── Input Schema ───

export const WebFetchInputSchema = z
  .object({
    url: z.string().describe("Fully formed HTTP or HTTPS URL. Embedded credentials are rejected."),
    format: z
      .enum(["markdown", "text", "html"])
      .default("markdown")
      .describe(
        "Output format: `markdown` extracts readable content and converts it to Markdown; `text` extracts plain text; `html` returns raw HTML. Default `markdown`.",
      ),
  })
  .strict();

export type WebFetchInput = z.infer<typeof WebFetchInputSchema>;

// ─── URL Validation ───

interface ValidatedURL {
  url: string;
  /** Original URL before any upgrades (e.g. http → https) */
  originalUrl: string;
}

export function validateUrl(raw: string): ValidatedURL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL.");
  }

  // Only allow http: and https: schemes
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol}. Only http:// and https:// are allowed.`);
  }

  // Block URLs with credentials (user:pass@host)
  if (url.username || url.password) {
    throw new Error("URLs with credentials (user:pass@host) are not allowed.");
  }

  // Enforce max URL length
  if (raw.length > MAX_URL_LENGTH) {
    throw new Error(`URL exceeds maximum length of ${MAX_URL_LENGTH} characters.`);
  }

  const originalUrl = url.href;

  // Upgrade http to https
  if (url.protocol === "http:") {
    url.protocol = "https:";
  }

  return { url: url.href, originalUrl };
}

// ─── Content Extraction ───

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
turndownService.use(gfm);

function extractContent(html: string, url: string, format: "markdown" | "text" | "html"): string {
  if (format === "html") {
    return html;
  }

  const dom = new JSDOM(html, { url });
  const document = dom.window.document;

  if (format === "text") {
    // Try Readability first; fall back to body text extraction
    const reader = new Readability(document);
    const article = reader.parse();
    if (article?.textContent?.trim()) {
      return article.textContent.trim();
    }
    // Fallback: extract <body> text
    const body = document.body;
    return body ? body.textContent?.trim() ?? "" : "";
  }

  // format === "markdown"
  // Try Readability article extraction → Turndown
  const reader = new Readability(document);
  const article = reader.parse();
  if (article?.content?.trim()) {
    return turndownService.turndown(article.content);
  }

  // Fallback: try <body> content → Turndown
  const body = document.body;
  if (body) {
    const bodyHtml = body.innerHTML;
    if (bodyHtml.trim()) {
      return turndownService.turndown(bodyHtml);
    }
  }

  // Last resort: return raw text
  return document.documentElement.textContent?.trim() ?? "";
}

// ─── Response Processing ───

interface FetchResult {
  statusCode: number;
  contentType: string;
  content: string;
  originalUrl: string;
  finalUrl: string;
}

export async function runWebFetch(
  input: WebFetchInput,
  ctx: ToolExecutionContext,
): Promise<RawToolResult> {
  // ── Validate URL ──
  let validated: ValidatedURL;
  try {
    validated = validateUrl(input.url);
  } catch (error) {
    return createToolErrorResult({
      kind: "webfetch-invalid-url",
      code: "TOOL_WEBFETCH_INVALID_URL",
      message: error instanceof Error ? error.message : `Invalid URL: ${input.url}`,
    });
  }

  // ── Fetch with timeout, redirect limit, and size limit ──
  let response: Response;
  let finalUrl = validated.url;
  let redirectCount = 0;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  // Also abort if the parent context signals abort
  const onParentAbort = () => controller.abort();
  ctx.abort.addEventListener("abort", onParentAbort, { once: true });

  try {
    // Manual redirect handling for security
    let currentUrl = validated.url;
    let nextResponse = await fetch(currentUrl, {
      signal: controller.signal,
      redirect: "manual", // We handle redirects ourselves
      headers: {
        "User-Agent": CHROME_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    // Follow redirects manually with security checks
    while ([301, 302, 303, 307, 308].includes(nextResponse.status) && redirectCount < MAX_REDIRECTS) {
      redirectCount++;
      const location = nextResponse.headers.get("location");
      if (!location) {
        return createToolErrorResult({
          kind: "webfetch-http-error",
          code: "TOOL_WEBFETCH_HTTP_ERROR",
          message: `HTTP ${nextResponse.status} redirect with no Location header`,
        });
      }

      const redirectUrl = new URL(location, currentUrl).href;
      try {
        validateUrl(redirectUrl);
      } catch {
        return createToolErrorResult({
          kind: "webfetch-invalid-url",
          code: "TOOL_WEBFETCH_INVALID_URL",
          message: "Redirect target URL is invalid.",
        });
      }

      currentUrl = redirectUrl;
      nextResponse = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": CHROME_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    }

    if ([301, 302, 303, 307, 308].includes(nextResponse.status)) {
      return createToolErrorResult({
        kind: "webfetch-http-error",
        code: "TOOL_WEBFETCH_HTTP_ERROR",
        message: `Too many redirects (>${MAX_REDIRECTS})`,
      });
    }

    response = nextResponse;
    finalUrl = currentUrl;
  } catch (error) {
    if (controller.signal.aborted && !ctx.abort.aborted) {
      _logger.warn("webfetch.timeout", {
        module: "webfetch",
        context: { code: "TOOL_WEBFETCH_TIMEOUT", timeoutMs: DEFAULT_TIMEOUT_MS },
      });
      return createToolErrorResult({
        kind: "webfetch-timeout",
        code: "TOOL_WEBFETCH_TIMEOUT",
        message: `Web fetch timed out after ${DEFAULT_TIMEOUT_MS}ms`,
      });
    }
    if (ctx.abort.aborted) {
      _logger.debug("webfetch.cancelled", {
        module: "webfetch",
        context: { code: "TOOL_CANCELLED" },
      });
      return createToolErrorResult({
        kind: "cancelled",
        code: "TOOL_CANCELLED",
        message: "Web fetch was cancelled",
      });
    }
    _logger.error("webfetch.failed", {
      module: "webfetch",
      context: { code: "TOOL_WEBFETCH_FAILED" },
    });
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_WEBFETCH_FAILED",
      message: "Web fetch request failed.",
    });
  } finally {
    clearTimeout(timeoutId);
    ctx.abort.removeEventListener("abort", onParentAbort);
  }

  // ── Check HTTP status ──
  const statusCode = response.status;

  // ── Stream response with size limit ──
  if (!response.body) {
    return createToolErrorResult({
      kind: "webfetch-http-error",
      code: "TOOL_WEBFETCH_HTTP_ERROR",
      message: `HTTP ${statusCode}: No response body`,
    });
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
    await response.body.cancel().catch(() => undefined);
    return createToolErrorResult({
      kind: "webfetch-size-exceeded",
      code: "TOOL_WEBFETCH_SIZE_EXCEEDED",
      message: `Response body (${contentLength} bytes) exceeds maximum size of ${MAX_RESPONSE_BYTES} bytes`,
    });
  }

  const buffer = new BoundedByteBuffer(MAX_RESPONSE_BYTES);

  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!buffer.append(value)) {
        await reader.cancel().catch(() => undefined);
        return createToolErrorResult({
          kind: "webfetch-size-exceeded",
          code: "TOOL_WEBFETCH_SIZE_EXCEEDED",
          message: `Response body exceeded maximum size of ${MAX_RESPONSE_BYTES} bytes during streaming`,
        });
      }
    }
  } catch (error) {
    if (ctx.abort.aborted) {
      _logger.debug("webfetch.stream.cancelled", {
        module: "webfetch",
        context: { code: "TOOL_CANCELLED" },
      });
      return createToolErrorResult({
        kind: "cancelled",
        code: "TOOL_CANCELLED",
        message: "Web fetch was cancelled during download",
      });
    }
    _logger.error("webfetch.stream.failed", {
      module: "webfetch",
      context: { code: "TOOL_WEBFETCH_STREAM_FAILED" },
    });
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_WEBFETCH_STREAM_FAILED",
      message: "Web fetch response stream failed.",
    });
  }

  // ── Decode response body ──
  const bodyText = new TextDecoder().decode(buffer.bytes());

  // ── Parse content type ──
  const contentTypeHeader = response.headers.get("content-type") ?? "";
  const contentType = contentTypeHeader.split(";")[0].trim().toLowerCase();

  // ── Handle non-HTML content types ──
  if (
    contentType.startsWith("application/json") ||
    contentType.startsWith("text/json")
  ) {
    return formatResult({
      statusCode,
      contentType: contentTypeHeader,
      content: bodyText,
      originalUrl: validated.originalUrl,
      finalUrl,
    });
  }

  if (
    contentType.startsWith("text/plain") ||
    contentType.startsWith("text/csv") ||
    contentType.startsWith("text/xml") ||
    contentType.startsWith("application/xml") ||
    contentType.startsWith("application/javascript") ||
    contentType.startsWith("text/javascript")
  ) {
    return formatResult({
      statusCode,
      contentType: contentTypeHeader,
      content: bodyText,
      originalUrl: validated.originalUrl,
      finalUrl,
    });
  }

  // Binary or unsupported content types
  if (
    contentType.startsWith("application/pdf") ||
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    contentType.startsWith("audio/") ||
    contentType.startsWith("application/zip") ||
    contentType.startsWith("application/octet-stream")
  ) {
    return createToolErrorResult({
      kind: "webfetch-content-type-unsupported",
      code: "TOOL_WEBFETCH_CONTENT_TYPE_UNSUPPORTED",
      message: `Unsupported content type: ${contentTypeHeader}.`,
    });
  }

  // ── Process HTML content ──
  let extractedContent: string;

  try {
    extractedContent = extractContent(bodyText, finalUrl, input.format);
  } catch {
    extractedContent = bodyText;
  }

  return formatResult({
    statusCode,
    contentType: contentTypeHeader,
    content: extractedContent,
    originalUrl: validated.originalUrl,
    finalUrl,
  });
}

// ─── Output Formatting ───

function formatResult(result: FetchResult): RawToolResult {
  const lines: string[] = [
    `<fetch-result>`,
    `<url>${result.finalUrl}</url>`,
    `<status>${result.statusCode}</status>`,
    `<content-type>${result.contentType}</content-type>`,
    `<content>`,
    result.content,
  ];

  lines.push(`</content>`);
  lines.push(`</fetch-result>`);

  return createTextToolResult(lines.join("\n"));
}

// ─── Tool Definition ───

export const webFetchTool = defineTool({
  name: "web_fetch",
  description:
    "Fetch an unauthenticated HTTP(S) URL and return markdown, text, or HTML. Prefer a specialized MCP tool for authenticated, private, or task-specific resources; this tool does not use browser cookies or login state. Response headers and all redirects share a fixed 30-second deadline; reading the response body is not covered by that timer. Initial HTTP URLs are upgraded to HTTPS, up to 5 redirects are followed, and response bodies over 5MB are rejected. HTML may be extracted and converted; output recovery is provided by the Tool Output Plane when needed.",
  inputSchema: WebFetchInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
  execute: async (input: WebFetchInput, ctx: ToolExecutionContext) => {
    return runWebFetch(input, ctx);
  },
});
