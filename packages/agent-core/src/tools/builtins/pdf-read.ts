import { z } from "zod";
import { getDocumentProxy } from "unpdf";
import { MAX_ATTACHMENT_SIZE_BYTES } from "@archcode/protocol";

import { TOOL_OUTPUT_ARTIFACT_MAX_BYTES, TOOL_OUTPUT_PREVIEW_MAX_BYTES } from "../../tool-output/constants";
import { utf8ByteLength } from "../../tool-output/utf8";
import { getSystemErrorCode } from "../../utils";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createSensitiveFilePermission, createWorkspacePermission } from "../permission";
import { createTextToolResult } from "../results";
import { resolveAndValidatePath } from "../security";
import type { RawToolResult } from "../types";

const PDF_HEADER = new TextEncoder().encode("%PDF-");
const PDF_HEADER_SEARCH_BYTES = 1_024;

export const PdfReadInputSchema = z
  .object({
    path: z.string().describe("Absolute or workspace-relative path to an authorized local PDF file."),
    startPage: z.number().int().positive().optional().describe("1-based first page to read. Defaults to 1."),
    pageCount: z.number().int().min(1).max(20).optional().describe("Number of pages to read, including startPage. Defaults to 1 and is limited to 20."),
  })
  .strict();

type PdfReadInput = z.infer<typeof PdfReadInputSchema>;

interface PdfErrorShape {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
}

interface TextContentChunk {
  readonly items: readonly unknown[];
}

interface StreamingTextPage {
  streamTextContent(): AsyncIterable<TextContentChunk>;
}

type PageTextStreamResult =
  | { readonly tooLarge: false; readonly text: string; readonly rawBytes: number }
  | { readonly tooLarge: true; readonly result: RawToolResult };

function hasPdfHeader(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - PDF_HEADER.length, PDF_HEADER_SEARCH_BYTES);
  for (let offset = 0; offset <= limit; offset += 1) {
    let matches = true;
    for (let index = 0; index < PDF_HEADER.length; index += 1) {
      if (bytes[offset + index] !== PDF_HEADER[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function normalizePageText(text: string): string {
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** @internal Exported only for focused streaming-contract tests. */
export async function readPageTextStream(
  page: StreamingTextPage,
  abort: AbortSignal,
  initialRawBytes = 0,
): Promise<PageTextStreamResult> {
  const parts: string[] = [];
  let rawBytes = initialRawBytes;

  for await (const content of page.streamTextContent()) {
    abort.throwIfAborted();
    for (const item of content.items) {
      abort.throwIfAborted();
      if (
        typeof item !== "object"
        || item === null
        || !("str" in item)
        || typeof item.str !== "string"
      ) {
        continue;
      }
      const hasEOL = "hasEOL" in item && item.hasEOL === true;
      const remainingBytes = TOOL_OUTPUT_ARTIFACT_MAX_BYTES - rawBytes;
      // Every UTF-8 encoding uses at least one byte per UTF-16 code unit. Reject
      // an oversized item before concatenating or encoding another large value.
      if (item.str.length + (hasEOL ? 1 : 0) > remainingBytes) {
        return { tooLarge: true, result: createPdfTextTooLargeResult() };
      }
      const part = `${item.str}${hasEOL ? "\n" : ""}`;
      const nextRawBytes = rawBytes + utf8ByteLength(part);
      if (nextRawBytes > TOOL_OUTPUT_ARTIFACT_MAX_BYTES) {
        return { tooLarge: true, result: createPdfTextTooLargeResult() };
      }
      parts.push(part);
      rawBytes = nextRawBytes;
    }
  }

  return {
    tooLarge: false,
    text: normalizePageText(parts.join("")),
    rawBytes,
  };
}

function pdfError(code: string, message: string, hint: string): RawToolResult {
  return createToolErrorResult({ kind: "execution", code, message, hint });
}

function createPdfTextTooLargeResult(): RawToolResult {
  return pdfError(
    "TOOL_PDF_TEXT_TOO_LARGE",
    "The selected pages contain more text than the output artifact system can preserve.",
    "Retry with a smaller pageCount. pdf_read will not silently discard extracted text or create a second paging system.",
  );
}

function classifyPdfParserError(error: unknown): RawToolResult {
  const shape = (typeof error === "object" && error !== null ? error : {}) as PdfErrorShape;
  const name = typeof shape.name === "string" ? shape.name : "";
  const message = typeof shape.message === "string" ? shape.message : String(error);

  if (name === "PasswordException" || /password/i.test(message)) {
    return pdfError(
      "TOOL_PDF_PASSWORD_REQUIRED",
      "The PDF is encrypted or requires a password, which pdf_read does not accept.",
      "Provide an unencrypted PDF; pdf_read never guesses, requests, or stores PDF passwords.",
    );
  }

  if (name === "InvalidPDFException" || name === "FormatError" || /invalid pdf|pdf structure|xref/i.test(message)) {
    return pdfError(
      "TOOL_PDF_CORRUPT",
      "The file has a PDF header but its PDF structure is damaged or invalid.",
      "Replace the file with a valid PDF. pdf_read does not repair damaged documents or use an external fallback.",
    );
  }

  return createToolErrorResult({
    kind: "execution",
    code: "TOOL_PDF_READ_FAILED",
    message: "The PDF could not be read.",
    hint: "Inspect the source PDF and retry only with a valid, unencrypted, native-text PDF.",
    error,
  });
}

function formatPdfOutput(input: {
  readonly resolvedPath: string;
  readonly startPage: number;
  readonly endPage: number;
  readonly totalPages: number;
  readonly pages: readonly { readonly pageNumber: number; readonly text: string }[];
}): string {
  const body = input.pages
    .map(({ pageNumber, text }) => `--- Page ${pageNumber} ---\n${text}`)
    .join("\n\n");
  const prefix = [
    `PDF: ${input.resolvedPath}`,
    `Pages: ${input.startPage}-${input.endPage} of ${input.totalPages}`,
  ];
  const complete = [...prefix, "Inline truncated: false", "", body].join("\n");
  if (new TextEncoder().encode(complete).byteLength <= TOOL_OUTPUT_PREVIEW_MAX_BYTES) return complete;
  return [...prefix, "Inline truncated: true (full selected-page text is available through the output artifact)", "", body].join("\n");
}

export const pdfReadTool = defineTool({
  name: "pdf_read",
  description: [
    "Extract native text from an authorized local PDF without OCR, external commands, or network access.",
    "startPage is 1-based and defaults to 1. pageCount defaults to 1 and must be between 1 and 20; a range extending past the document ends at the final page.",
    "The result contains a separate section for each selected page. If the inline 50 KiB preview is truncated, the complete selected-page text is captured by the existing output artifact system for output_read/output_search recovery.",
    "Encrypted/password-protected, damaged, non-PDF, and scanned or otherwise textless documents return distinct errors. Embedded scripts, attachments, links, and forms are not executed or fetched.",
  ].join("\n\n"),
  inputSchema: PdfReadInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  outputPolicy: { kind: "artifact", previewDirection: "head" },
  permissions: [createWorkspacePermission(), createSensitiveFilePermission()],
  execute: async (input: PdfReadInput, ctx): Promise<RawToolResult> => {
    const { resolved } = resolveAndValidatePath(input.path, ctx.cwd);

    let bytes: Uint8Array;
    try {
      const file = Bun.file(resolved);
      if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
        return pdfError(
          "TOOL_PDF_TOO_LARGE",
          `The PDF exceeds the fixed ${MAX_ATTACHMENT_SIZE_BYTES} byte read limit.`,
          "Use a smaller PDF. pdf_read does not stream or partially parse oversized documents.",
        );
      }
      bytes = await file.bytes();
    } catch (error) {
      const code = getSystemErrorCode(error);
      if (code === "ENOENT") {
        return createToolErrorResult({ kind: "file-not-found", code: "TOOL_FILE_NOT_FOUND", message: `File not found: ${input.path}` });
      }
      if (code === "EACCES" || code === "EPERM") {
        return createToolErrorResult({ kind: "file-permission-denied", code: "TOOL_FILE_PERMISSION_DENIED", message: `Permission denied: ${input.path}` });
      }
      return createToolErrorResult({ kind: "execution", error });
    }

    if (bytes.byteLength > MAX_ATTACHMENT_SIZE_BYTES) {
      return pdfError(
        "TOOL_PDF_TOO_LARGE",
        `The PDF exceeds the fixed ${MAX_ATTACHMENT_SIZE_BYTES} byte read limit.`,
        "Use a smaller PDF. pdf_read does not stream or partially parse oversized documents.",
      );
    }

    if (!hasPdfHeader(bytes)) {
      return pdfError(
        "TOOL_PDF_NOT_PDF",
        "The file is not a PDF: no PDF header was found in the first 1,024 bytes.",
        "Use pdf_read only with a local PDF file. Other binary formats require their own reader.",
      );
    }

    let document: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
    try {
      document = await getDocumentProxy(bytes, {
        disableAutoFetch: true,
        disableRange: true,
        disableStream: true,
        disableFontFace: true,
        useSystemFonts: true,
        useWorkerFetch: false,
      });

      const startPage = input.startPage ?? 1;
      if (startPage > document.numPages) {
        return pdfError(
          "TOOL_PDF_PAGE_OUT_OF_RANGE",
          `startPage ${startPage} is outside this ${document.numPages}-page PDF.`,
          `Retry with startPage between 1 and ${document.numPages}.`,
        );
      }

      const endPage = Math.min(document.numPages, startPage + (input.pageCount ?? 1) - 1);
      const pages: { pageNumber: number; text: string }[] = [];
      let hasText = false;
      let rawTextBytes = 0;
      for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
        ctx.abort.throwIfAborted();
        const page = await document.getPage(pageNumber);
        const streamed = await readPageTextStream(
          page as unknown as StreamingTextPage,
          ctx.abort,
          rawTextBytes,
        );
        if (streamed.tooLarge) return streamed.result;
        rawTextBytes = streamed.rawBytes;
        const { text } = streamed;
        hasText ||= text.length > 0;
        pages.push({ pageNumber, text: text.length > 0 ? text : "[No extractable native text on this page]" });
      }

      if (!hasText) {
        return pdfError(
          "TOOL_PDF_NO_TEXT",
          `Pages ${startPage}-${endPage} contain no extractable native text; the PDF may be scanned or image-only.`,
          "pdf_read does not perform OCR. Provide a native-text PDF or use a separately authorized OCR workflow.",
        );
      }

      const output = formatPdfOutput({
        resolvedPath: resolved,
        startPage,
        endPage,
        totalPages: document.numPages,
        pages,
      });
      if (new TextEncoder().encode(output).byteLength > TOOL_OUTPUT_ARTIFACT_MAX_BYTES) {
        return createPdfTextTooLargeResult();
      }
      return createTextToolResult(output);
    } catch (error) {
      if (ctx.abort.aborted) {
        return createToolErrorResult({
          kind: "cancelled",
          code: "TOOL_PDF_READ_ABORTED",
          message: "PDF text extraction was aborted.",
        });
      }
      return classifyPdfParserError(error);
    } finally {
      await document?.loadingTask.destroy().catch(() => undefined);
    }
  },
});
