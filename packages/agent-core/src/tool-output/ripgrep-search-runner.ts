import { ToolOutputError } from "./errors";
import type {
  ArtifactSearchRunner,
  ArtifactSearchRunnerMatch,
  ArtifactSearchSegment,
} from "./artifact-types";
import { createBinaryManager } from "../binary/manager";
import { decodeUtf8, safeUtf8End, utf8ByteLength } from "./utf8";

interface RunnerCursor {
  readonly v: 1;
  readonly segmentIndex: number;
  readonly ordinal: number;
}

interface ParsedMatch {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly snippet: string;
}

function parseCursor(cursor: string | undefined): RunnerCursor {
  if (cursor === undefined) return { v: 1, segmentIndex: 0, ordinal: -1 };
  try {
    const value = JSON.parse(cursor) as Partial<RunnerCursor>;
    if (
      value.v !== 1 ||
      !Number.isSafeInteger(value.segmentIndex) ||
      value.segmentIndex! < 0 ||
      !Number.isSafeInteger(value.ordinal) ||
      value.ordinal! < -1 ||
      Object.keys(value).length !== 3
    ) {
      throw new Error("invalid cursor");
    }
    return value as RunnerCursor;
  } catch {
    throw new ToolOutputError("TOOL_OUTPUT_INVALID_CURSOR");
  }
}

class BoundedRgLineParser {
  private phase: "line" | "offset" | "match" = "line";
  private lineDigits = "";
  private offsetDigits = "";
  private prefixBytes = 0;
  private matchBytes = 0;
  private snippet: number[] = [];

  constructor(
    private readonly maxSnippetBytes: number,
    private readonly onMatch: (match: ParsedMatch) => boolean,
  ) {}

  feed(chunk: Uint8Array): boolean {
    for (const byte of chunk) {
      if (this.phase === "line") {
        this.prefixBytes += 1;
        if (this.prefixBytes > 128) throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
        if (byte === 0x3a) {
          if (!/^\d+$/.test(this.lineDigits)) throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
          this.phase = "offset";
        } else {
          this.lineDigits += String.fromCharCode(byte);
        }
        continue;
      }
      if (this.phase === "offset") {
        this.prefixBytes += 1;
        if (this.prefixBytes > 128) throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
        if (byte === 0x3a) {
          if (!/^\d+$/.test(this.offsetDigits)) throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
          this.phase = "match";
        } else {
          this.offsetDigits += String.fromCharCode(byte);
        }
        continue;
      }
      if (byte === 0x0a) {
        if (!this.finishLine()) return false;
      } else {
        this.matchBytes += 1;
        // Three bytes of lookahead are enough to decide a UTF-8 boundary at
        // the 1 KiB snippet cut without retaining an unbounded match.
        if (this.snippet.length < this.maxSnippetBytes + 3) this.snippet.push(byte);
      }
    }
    return true;
  }

  finish(): boolean {
    if (this.phase === "line" && this.lineDigits.length === 0) return true;
    if (this.phase !== "match") throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
    return this.finishLine();
  }

  private finishLine(): boolean {
    const offset = Number(this.offsetDigits);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
    }
    const snippetBytes = Uint8Array.from(this.snippet);
    const safeEnd = this.matchBytes > this.maxSnippetBytes
      ? safeUtf8End(snippetBytes, this.maxSnippetBytes)
      : snippetBytes.byteLength;
    const shouldContinue = this.onMatch({
      byteOffset: offset,
      byteLength: this.matchBytes,
      snippet: decodeUtf8(snippetBytes.subarray(0, safeEnd)),
    });
    this.phase = "line";
    this.lineDigits = "";
    this.offsetDigits = "";
    this.prefixBytes = 0;
    this.matchBytes = 0;
    this.snippet = [];
    return shouldContinue;
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
      // Deliberately discard diagnostics. Raw paths/output never enter an error.
    }
  } finally {
    reader.releaseLock();
  }
}

export interface RipgrepArtifactSearchProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}

export interface RipgrepArtifactSearchRunnerOptions {
  readonly binaryResolver?: {
    resolve(binaryId: "rg"): Promise<string>;
  };
  readonly spawn?: (argv: readonly string[]) => RipgrepArtifactSearchProcess;
}

function spawnRipgrep(argv: readonly string[]): RipgrepArtifactSearchProcess {
  const process = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    exited: process.exited,
    kill: () => process.kill(),
  };
}

export class RipgrepArtifactSearchRunner implements ArtifactSearchRunner {
  private readonly binaryResolver: NonNullable<RipgrepArtifactSearchRunnerOptions["binaryResolver"]>;
  private readonly spawn: (argv: readonly string[]) => RipgrepArtifactSearchProcess;

  constructor(options: RipgrepArtifactSearchRunnerOptions = {}) {
    this.binaryResolver = options.binaryResolver ?? createBinaryManager();
    this.spawn = options.spawn ?? spawnRipgrep;
  }

  async search(input: Parameters<ArtifactSearchRunner["search"]>[0]): Promise<{
    matches: readonly ArtifactSearchRunnerMatch[];
    nextCursor?: string;
  }> {
    const cursor = parseCursor(input.cursor);
    if (cursor.segmentIndex > input.segments.length) {
      throw new ToolOutputError("TOOL_OUTPUT_INVALID_CURSOR");
    }
    if (cursor.segmentIndex === input.segments.length) {
      return { matches: [] };
    }
    let binary: string;
    try {
      binary = await this.binaryResolver.resolve("rg");
    } catch {
      throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
    }
    if (input.signal.aborted || Date.now() >= input.deadlineAt) {
      throw new ToolOutputError("TOOL_OUTPUT_SEARCH_TIMEOUT");
    }
    const matches: ArtifactSearchRunnerMatch[] = [];
    let contentBytes = 0;
    let lastReturned: { segmentIndex: number; ordinal: number } | undefined;
    let hasMore = false;

    for (let segmentIndex = cursor.segmentIndex; segmentIndex < input.segments.length; segmentIndex += 1) {
      if (input.signal.aborted || Date.now() >= input.deadlineAt) {
        throw new ToolOutputError("TOOL_OUTPUT_SEARCH_TIMEOUT");
      }
      const segment = input.segments[segmentIndex]!;
      let ordinal = -1;
      const skipOrdinal = segmentIndex === cursor.segmentIndex ? cursor.ordinal : -1;
      let stoppedForPage = false;
      let process: RipgrepArtifactSearchProcess;
      try {
        process = this.spawn(
          [
            binary,
            "--no-heading",
            "--color=never",
            "--line-number",
            "--byte-offset",
            "--only-matching",
            "--regexp",
            input.pattern,
            segment.path,
          ],
        );
      } catch {
        throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
      }
      const abort = () => process.kill();
      input.signal.addEventListener("abort", abort, { once: true });
      const stderr = drain(process.stderr);
      const parser = new BoundedRgLineParser(1_024, (parsed) => {
        ordinal += 1;
        if (ordinal <= skipOrdinal) return true;
        const snippetBytes = utf8ByteLength(parsed.snippet);
        if (
          matches.length >= input.limit ||
          contentBytes + snippetBytes > input.maxContentBytes
        ) {
          hasMore = true;
          stoppedForPage = true;
          process.kill();
          return false;
        }
        matches.push({
          segment: segment.kind,
          canonicalStart: segment.canonicalStart + parsed.byteOffset,
          canonicalEnd: segment.canonicalStart + parsed.byteOffset + parsed.byteLength,
          snippet: parsed.snippet,
        });
        contentBytes += snippetBytes;
        lastReturned = { segmentIndex, ordinal };
        return true;
      });
      try {
        const reader = process.stdout.getReader();
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            if (!parser.feed(item.value)) break;
          }
          if (!stoppedForPage) parser.finish();
        } finally {
          reader.releaseLock();
        }
        const exitCode = await process.exited;
        await stderr;
        if (input.signal.aborted || Date.now() >= input.deadlineAt) {
          throw new ToolOutputError("TOOL_OUTPUT_SEARCH_TIMEOUT");
        }
        if (!stoppedForPage && exitCode === 2) {
          throw new ToolOutputError("TOOL_OUTPUT_INVALID_PATTERN");
        }
        if (!stoppedForPage && exitCode !== 0 && exitCode !== 1) {
          throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
        }
      } finally {
        input.signal.removeEventListener("abort", abort);
      }
      if (hasMore) break;
    }

    return {
      matches,
      nextCursor: hasMore && lastReturned
        ? JSON.stringify({ v: 1, ...lastReturned })
        : undefined,
    };
  }
}
