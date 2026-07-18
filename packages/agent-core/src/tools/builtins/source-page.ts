import type { JsonObject } from "@archcode/protocol";
import { createSourceToolResult } from "../results";
import type { RawToolResult } from "../types";

export const SOURCE_PAGE_MAX_BYTES = 50 * 1024;
export const SOURCE_PAGE_MAX_LINES = 2_000;

const encoder = new TextEncoder();

export interface SourcePageInput {
  readonly lines: readonly string[];
  readonly offset: number;
  readonly recordLimit?: number;
  readonly nextInput: (nextOffset: number) => JsonObject;
  readonly emptyText: string;
}

/** Build one deterministic source page without relying on finalizer truncation. */
export function createLineSourcePage(input: SourcePageInput): RawToolResult {
  if (input.offset < 0 || !Number.isSafeInteger(input.offset)) {
    throw new TypeError("Source page offset must be a non-negative safe integer");
  }
  if (input.lines.length === 0 || input.offset >= input.lines.length) {
    return createSourceToolResult(input.emptyText);
  }

  const selected: string[] = [];
  let bytes = 0;
  let index = input.offset;
  const recordLimit = Math.min(input.recordLimit ?? SOURCE_PAGE_MAX_LINES, SOURCE_PAGE_MAX_LINES);
  while (index < input.lines.length && selected.length < recordLimit) {
    const separatorBytes = selected.length === 0 ? 0 : 1;
    const lineBytes = encoder.encode(input.lines[index]!).byteLength;
    if (bytes + separatorBytes + lineBytes > SOURCE_PAGE_MAX_BYTES) break;
    selected.push(input.lines[index]!);
    bytes += separatorBytes + lineBytes;
    index += 1;
  }

  if (selected.length === 0) {
    throw new Error("A single source record exceeds the 50 KiB page limit");
  }

  return createSourceToolResult(
    selected.join("\n"),
    index < input.lines.length ? input.nextInput(index) : undefined,
  );
}

export function sourceDraftText(result: RawToolResult): string {
  if (result.draft.kind !== "source") throw new TypeError("Expected source draft");
  return result.draft.text;
}
