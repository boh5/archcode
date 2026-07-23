import { readFile } from "node:fs/promises";

import type { ArtifactSearchRunner, ArtifactSearchRunnerMatch } from "../artifact-types";
import { ToolOutputError } from "../errors";
import { safeUtf8End, utf8ByteLength } from "../utf8";

interface SearchCursor {
  readonly v: 1;
  readonly segmentIndex: number;
  readonly matchIndex: number;
}

const MAX_SNIPPET_BYTES = 1_024;

/**
 * Test-only search adapter for user-story coverage.
 *
 * Production search uses RipgrepArtifactSearchRunner. This adapter keeps the
 * surrounding artifact workflow hermetic so the default test suite never
 * needs an installed binary or network download.
 */
export function createHermeticArtifactSearchRunner(): ArtifactSearchRunner {
  return {
    async search(input) {
      const cursor = parseCursor(input.cursor);
      const expression = compilePattern(input.pattern);
      const matches: ArtifactSearchRunnerMatch[] = [];
      let contentBytes = 0;

      for (
        let segmentIndex = cursor.segmentIndex;
        segmentIndex < input.segments.length;
        segmentIndex += 1
      ) {
        assertActive(input.signal, input.deadlineAt);
        const segment = input.segments[segmentIndex]!;
        const content = await readFile(segment.path, "utf8");
        const segmentMatches = [...content.matchAll(expression)];
        const startMatchIndex = segmentIndex === cursor.segmentIndex
          ? cursor.matchIndex
          : 0;

        for (let matchIndex = startMatchIndex; matchIndex < segmentMatches.length; matchIndex += 1) {
          assertActive(input.signal, input.deadlineAt);
          const match = segmentMatches[matchIndex]!;
          const matchedText = match[0];
          const snippet = boundedSnippet(matchedText);
          const snippetBytes = utf8ByteLength(snippet);

          if (
            matches.length >= input.limit
            || contentBytes + snippetBytes > input.maxContentBytes
          ) {
            return {
              matches,
              nextCursor: JSON.stringify({ v: 1, segmentIndex, matchIndex }),
            };
          }

          const byteOffset = utf8ByteLength(content.slice(0, match.index));
          const byteLength = utf8ByteLength(matchedText);
          matches.push({
            segment: segment.kind,
            canonicalStart: segment.canonicalStart + byteOffset,
            canonicalEnd: segment.canonicalStart + byteOffset + byteLength,
            snippet,
          });
          contentBytes += snippetBytes;
        }
      }

      return { matches };
    },
  };
}

function parseCursor(cursor: string | undefined): SearchCursor {
  if (cursor === undefined) return { v: 1, segmentIndex: 0, matchIndex: 0 };
  try {
    const value = JSON.parse(cursor) as Partial<SearchCursor>;
    if (
      value.v !== 1
      || !Number.isSafeInteger(value.segmentIndex)
      || value.segmentIndex! < 0
      || !Number.isSafeInteger(value.matchIndex)
      || value.matchIndex! < 0
      || Object.keys(value).length !== 3
    ) {
      throw new Error("invalid cursor");
    }
    return value as SearchCursor;
  } catch {
    throw new ToolOutputError("TOOL_OUTPUT_INVALID_CURSOR");
  }
}

function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "gu");
  } catch {
    throw new ToolOutputError("TOOL_OUTPUT_INVALID_PATTERN");
  }
}

function boundedSnippet(content: string): string {
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength <= MAX_SNIPPET_BYTES) return content;
  return new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(0, safeUtf8End(bytes, MAX_SNIPPET_BYTES)),
  );
}

function assertActive(signal: AbortSignal, deadlineAt: number): void {
  if (signal.aborted || Date.now() >= deadlineAt) {
    throw new ToolOutputError("TOOL_OUTPUT_SEARCH_TIMEOUT");
  }
}
