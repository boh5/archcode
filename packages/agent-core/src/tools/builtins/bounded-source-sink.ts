import type { ProcessOutputSink } from "../../process/types";

const MAX_PENDING_LINE_BYTES = 64 * 1024;

/**
 * Canonical source-page collector. It drains every stdout byte but retains only
 * the requested offset window, so ProcessRunner's diagnostic ring is never
 * treated as the source-of-truth result set.
 */
export function createBoundedSourceLineSink(
  offset: number,
  limit: number,
  mapLine: (line: string) => string | undefined,
): { sink: ProcessOutputSink; finish(): readonly string[] } {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let pending = "";
  let seen = 0;
  const consume = (line: string) => {
    if (Buffer.byteLength(line, "utf8") > MAX_PENDING_LINE_BYTES) {
      throw new Error("Source record exceeded 64 KiB");
    }
    const mapped = mapLine(line);
    if (mapped === undefined) return;
    if (seen++ < offset) return;
    if (lines.length < limit + 1) lines.push(mapped);
  };
  return {
    sink: {
      write(stream, chunk) {
        if (stream !== "stdout") return;
        pending += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          consume(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
        if (new TextEncoder().encode(pending).byteLength > MAX_PENDING_LINE_BYTES) {
          throw new Error("Source record exceeded 64 KiB");
        }
      },
    },
    finish() {
      const trailing = pending + decoder.decode();
      if (trailing.length > 0) consume(trailing);
      return lines;
    },
  };
}
