import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { TOOL_OUTPUT_ARTIFACT_MAX_BYTES, TOOL_OUTPUT_PREVIEW_MAX_BYTES } from "../../tool-output/constants";
import { ToolOutputArtifactStore } from "../../tool-output/artifact-store";
import { ToolOutputFinalizer } from "../../tool-output/finalizer";
import { storeManager } from "../../store/store";
import { createMockStore } from "../../store/test-helpers";
import { createTestProjectContext } from "../test-project-context";
import type { RawToolResult, ToolExecutionContext } from "../types";
import { pdfReadTool, readPageTextStream } from "./pdf-read";

const workspace = join("/tmp", "archcode-pdf-read", crypto.randomUUID());
const encoder = new TextEncoder();

function ctx(): ToolExecutionContext {
  return {
    store: createMockStore(),
    storeManager,
    toolName: "pdf_read",
    toolCallId: "call",
    input: {},
    step: 1,
    executionId: "test-execution",
    runOrdinal: 0,
    toolBatchId: "test-tool-batch",
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["pdf_read"]),
    cwd: workspace,
    projectContext: createTestProjectContext(workspace),
  };
}

function escapePdfString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function createPdf(pageTexts: readonly string[], encrypted = false): Uint8Array {
  const objects: string[] = [];
  const fontObject = 3 + pageTexts.length * 2;
  const pageRefs = pageTexts.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pageTexts.length} >>`);

  for (const [index, text] of pageTexts.entries()) {
    const contentObject = 4 + index * 2;
    const stream = text.length === 0
      ? ""
      : `BT /F1 12 Tf 14 TL 72 720 Td ${text.split("\n").map((line) => `(${escapePdfString(line)}) Tj T*`).join(" ")} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`);
    objects.push(`<< /Length ${encoder.encode(stream).byteLength} >>\nstream\n${stream}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let encryptObject: number | undefined;
  if (encrypted) {
    encryptObject = objects.length + 1;
    const owner = "0".repeat(32);
    const user = "1".repeat(32);
    objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O (${owner}) /U (${user}) /P -4 >>`);
  }

  let output = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(encoder.encode(output).byteLength);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = encoder.encode(output).byteLength;
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  const encryptionTrailer = encryptObject === undefined
    ? ""
    : ` /Encrypt ${encryptObject} 0 R /ID [<00112233445566778899AABBCCDDEEFF><00112233445566778899AABBCCDDEEFF>]`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptionTrailer} >>\n`;
  output += `startxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(output);
}

async function write(name: string, bytes: string | Uint8Array): Promise<void> {
  await Bun.write(join(workspace, name), bytes);
}

function draftText(result: RawToolResult): string {
  if (result.draft.kind === "capture") throw new Error("Unexpected capture draft");
  return result.draft.text;
}

function errorCode(result: RawToolResult): string | undefined {
  if (!result.isError) return undefined;
  return (JSON.parse(draftText(result)) as { code?: string }).code;
}

beforeEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("pdf_read", () => {
  test("preserves item order and EOL markers across text-content chunks", async () => {
    const page = {
      async *streamTextContent() {
        yield { items: [{ str: "first", hasEOL: true }, { str: "second" }] };
        yield { items: [{ str: " + third", hasEOL: true }, { type: "beginMarkedContent" }, { str: "fourth" }] };
      },
    };

    const result = await readPageTextStream(page, new AbortController().signal);
    expect(result).toEqual({
      tooLarge: false,
      text: "first\nsecond + third\nfourth",
      rawBytes: encoder.encode("first\nsecond + third\nfourth").byteLength,
    });
  });

  test("observes abort between text-content chunks before reading another item", async () => {
    const controller = new AbortController();
    let secondItemRead = false;
    const secondItem = Object.defineProperty({}, "str", {
      enumerable: true,
      get() {
        secondItemRead = true;
        return "second";
      },
    });
    const page = {
      async *streamTextContent() {
        yield { items: [{ str: "first" }] };
        controller.abort();
        yield { items: [secondItem] };
      },
    };

    await expect(readPageTextStream(page, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(secondItemRead).toBe(false);
  });

  test("rejects raw streamed text before consuming later chunks when the artifact cap would be exceeded", async () => {
    let laterChunkRequested = false;
    const page = {
      async *streamTextContent() {
        yield { items: [{ str: "abcd", hasEOL: true }] };
        laterChunkRequested = true;
        yield { items: [{ str: "must not be consumed" }] };
      },
    };

    const result = await readPageTextStream(
      page,
      new AbortController().signal,
      TOOL_OUTPUT_ARTIFACT_MAX_BYTES - 4,
    );
    expect(result.tooLarge).toBe(true);
    if (!result.tooLarge) throw new Error("Expected early size rejection");
    expect(errorCode(result.result)).toBe("TOOL_PDF_TEXT_TOO_LARGE");
    expect(laterChunkRequested).toBe(false);
  });

  test("extracts only the requested 1-based page range without fetching", async () => {
    await write("sample.pdf", createPdf(["page one", "page two", "page three"]));
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("pdf_read attempted network access");
    }) as unknown as typeof fetch;

    try {
      const result = await pdfReadTool.execute({ path: "sample.pdf", startPage: 2, pageCount: 20 }, ctx());
      expect(result.isError).toBe(false);
      expect(draftText(result)).toContain("Pages: 2-3 of 3");
      expect(draftText(result)).toContain("--- Page 2 ---\npage two");
      expect(draftText(result)).toContain("--- Page 3 ---\npage three");
      expect(draftText(result)).not.toContain("page one");
      expect(fetchCalls).toBe(0);

      const defaultResult = await pdfReadTool.execute({ path: "sample.pdf" }, ctx());
      expect(draftText(defaultResult)).toContain("Pages: 1-1 of 3");
      expect(draftText(defaultResult)).toContain("page one");
      expect(draftText(defaultResult)).not.toContain("page two");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("marks output above 51,200 UTF-8 bytes for artifact recovery", async () => {
    const page = Array.from({ length: 1_000 }, (_, index) => `line ${index} ${"x".repeat(52)}`).join("\n");
    await write("large.pdf", createPdf(Array.from({ length: 20 }, () => page)));
    const result = await pdfReadTool.execute({ path: "large.pdf", pageCount: 20 }, ctx());

    expect(result.isError).toBe(false);
    expect(pdfReadTool.outputPolicy).toEqual({ kind: "artifact", previewDirection: "head" });
    expect(encoder.encode(draftText(result)).byteLength).toBeGreaterThan(TOOL_OUTPUT_PREVIEW_MAX_BYTES);
    expect(draftText(result)).toContain("Pages: 1-20 of 20");
    expect(draftText(result)).toContain("Inline truncated: true");

    const artifactStore = new ToolOutputArtifactStore({ rootDir: join(workspace, "artifacts") });
    try {
      const finalizer = new ToolOutputFinalizer({ artifactStore });
      const executionContext = ctx();
      const capture = await finalizer.beginCapture(pdfReadTool, executionContext);
      executionContext.outputCapture = capture;
      const finalized = await finalizer.finalize({
        descriptor: pdfReadTool,
        raw: result,
        context: executionContext,
        capture,
        attempted: true,
      });
      expect(encoder.encode(finalized.output.preview).byteLength).toBeLessThanOrEqual(TOOL_OUTPUT_PREVIEW_MAX_BYTES);
      expect(finalized.output.preview).toContain("Inline truncated: true");
      expect(finalized.output.completeness).toBe("partial");
      expect(finalized.output.recovery.kind).toBe("artifact");
    } finally {
      await artifactStore.dispose();
    }
  });

  test("uses strict bounded page inputs", () => {
    expect(pdfReadTool.inputSchema.safeParse({ path: "x.pdf", startPage: 1, pageCount: 1 }).success).toBe(true);
    expect(pdfReadTool.inputSchema.safeParse({ path: "x.pdf", pageCount: 20 }).success).toBe(true);
    expect(pdfReadTool.inputSchema.safeParse({ path: "x.pdf", startPage: 0 }).success).toBe(false);
    expect(pdfReadTool.inputSchema.safeParse({ path: "x.pdf", pageCount: 21 }).success).toBe(false);
    expect(pdfReadTool.inputSchema.safeParse({ path: "x.pdf", extra: true }).success).toBe(false);
  });

  test("distinguishes non-PDF, damaged, encrypted, and textless PDFs", async () => {
    await write("not.pdf", "plain text");
    await write("damaged.pdf", "%PDF-1.7\nthis is not a valid PDF");
    await write("encrypted.pdf", createPdf(["secret"], true));
    await write("blank.pdf", createPdf([""]));

    const nonPdf = await pdfReadTool.execute({ path: "not.pdf" }, ctx());
    const damaged = await pdfReadTool.execute({ path: "damaged.pdf" }, ctx());
    const encrypted = await pdfReadTool.execute({ path: "encrypted.pdf" }, ctx());
    const blank = await pdfReadTool.execute({ path: "blank.pdf" }, ctx());

    expect(errorCode(nonPdf)).toBe("TOOL_PDF_NOT_PDF");
    expect(errorCode(damaged)).toBe("TOOL_PDF_CORRUPT");
    expect(errorCode(encrypted)).toBe("TOOL_PDF_PASSWORD_REQUIRED");
    expect(errorCode(blank)).toBe("TOOL_PDF_NO_TEXT");
  });

  test("reports missing files and out-of-range start pages distinctly", async () => {
    const missing = await pdfReadTool.execute({ path: "missing.pdf" }, ctx());
    expect(errorCode(missing)).toBe("TOOL_FILE_NOT_FOUND");

    await write("one-page.pdf", createPdf(["one"]));
    const outOfRange = await pdfReadTool.execute({ path: "one-page.pdf", startPage: 2 }, ctx());
    expect(errorCode(outOfRange)).toBe("TOOL_PDF_PAGE_OUT_OF_RANGE");
  });

  test("keeps workspace and sensitive-file permissions", async () => {
    expect((await pdfReadTool.permissions![0]!({ path: "../outside.pdf" }, ctx())).outcome).toBe("ask");
    expect((await pdfReadTool.permissions![1]!({ path: ".env.pdf" }, ctx())).outcome).toBe("ask");
  });
});
