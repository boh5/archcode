import { appendFile, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TOOL_OUTPUT_ARTIFACT_HEAD_MAX_BYTES,
  TOOL_OUTPUT_ARTIFACT_MAX_BYTES,
  TOOL_OUTPUT_ARTIFACT_TAIL_MAX_BYTES,
  TOOL_OUTPUT_CAPTURE_FINALIZE_WAIT_MS,
  TOOL_OUTPUT_CAPTURE_QUEUE_MAX_BYTES,
  TOOL_OUTPUT_CAPTURE_QUEUE_WAIT_MS,
  TOOL_OUTPUT_PREVIEW_MAX_BYTES,
} from "./constants";
import { ToolOutputError } from "./errors";
import { projectCanonicalText } from "./projection";
import type {
  ArtifactOwner,
  ArtifactProjection,
  ArtifactSegmentMetadata,
  CreatedArtifact,
} from "./artifact-types";
import { safeUtf8End, safeUtf8Start } from "./utf8";
import type { StreamingTextRedactor } from "../security";

const HEAD_PART_FILE = "head.part";
const TAIL_RING_FILE = "tail.ring";
const COPY_CHUNK_BYTES = 64 * 1024;

export type CaptureState =
  | "accepting"
  | "discarding"
  | "finalizing"
  | "completed"
  | "finalized"
  | "discarded"
  | "aborted";

export interface BeginCaptureInput {
  readonly owner: ArtifactOwner;
  readonly previewDirection?: "head" | "head-tail";
  readonly redactor: StreamingTextRedactor;
}

export interface CaptureStats {
  readonly state: CaptureState;
  readonly observedBytes: number;
  readonly observedLines: number;
  readonly canonicalBytes: number;
  readonly canonicalLines: number;
  readonly queuedBytes: number;
  readonly discardedBytes: number;
}

export interface CapturedArtifactDraft {
  readonly tempDir: string;
  readonly owner: ArtifactOwner;
  readonly observed: { readonly bytes: number; readonly lines: number };
  readonly canonical: { readonly bytes: number; readonly lines: number };
  readonly stored: { readonly bytes: number; readonly lines: number };
  readonly omitted: { readonly bytes: number; readonly lines: number };
  readonly segments: readonly ArtifactSegmentMetadata[];
  readonly projection: ArtifactProjection;
}

export interface CapturedOutput {
  readonly projection: ArtifactProjection;
  readonly observed: { readonly bytes: number; readonly lines: number };
  readonly canonical: { readonly bytes: number; readonly lines: number };
  readonly stored: { readonly bytes: number; readonly lines: number };
  readonly omitted: { readonly bytes: number; readonly lines: number };
  readonly artifactRequired: boolean;
}

export interface CaptureCommitter {
  commit(
    draft: CapturedArtifactDraft,
    generationIsActive: () => boolean,
  ): Promise<CreatedArtifact>;
}

export interface ToolOutputCapture {
  readonly signal: AbortSignal;
  readonly state: CaptureState;
  write(chunk: string | Uint8Array): Promise<"accepted" | "discarded">;
  complete(): Promise<CapturedOutput>;
  commit(completed: CapturedOutput): Promise<CreatedArtifact>;
  discard(completed: CapturedOutput): Promise<void>;
  abort(): Promise<void>;
  stats(): CaptureStats;
}

export interface StreamingCaptureOptions {
  readonly tempDir: string;
  readonly input: BeginCaptureInput;
  readonly committer: CaptureCommitter;
  readonly queueMaxBytes?: number;
  readonly queueWaitMs?: number;
  readonly finalizeWaitMs?: number;
  readonly artifactMaxBytes?: number;
  readonly headMaxBytes?: number;
  readonly tailMaxBytes?: number;
  readonly beforePersist?: (bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
  readonly onTerminal?: () => void;
}

class PreviewAccumulator {
  private head: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private headSealed = false;
  private tail: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private totalBytes = 0;

  append(bytes: Uint8Array): void {
    this.totalBytes += bytes.byteLength;
    if (!this.headSealed && this.head.byteLength < TOOL_OUTPUT_PREVIEW_MAX_BYTES) {
      const remaining = TOOL_OUTPUT_PREVIEW_MAX_BYTES - this.head.byteLength;
      const end = safeUtf8End(bytes, Math.min(remaining, bytes.byteLength));
      this.head = concatBytes(this.head, bytes.subarray(0, end));
      if (end < bytes.byteLength) this.headSealed = true;
    }
    const combined = concatBytes(this.tail, bytes);
    const start = safeUtf8Start(
      combined,
      Math.max(0, combined.byteLength - TOOL_OUTPUT_PREVIEW_MAX_BYTES),
    );
    this.tail = combined.subarray(start).slice();
  }

  project(direction: "head" | "head-tail"): ArtifactProjection {
    if (this.totalBytes <= TOOL_OUTPUT_PREVIEW_MAX_BYTES) {
      return projectCanonicalText(this.head, direction);
    }
    if (direction === "head") {
      const projected = projectCanonicalText(this.head, "head");
      return { ...projected, completeness: "partial", omittedBytes: this.totalBytes - this.head.byteLength };
    }
    const overlapBytes = Math.max(
      0,
      this.head.byteLength + this.tail.byteLength - this.totalBytes,
    );
    const tailStart = safeUtf8Start(this.tail, overlapBytes);
    const combined = concatBytes(this.head, this.tail.subarray(tailStart));
    const projected = projectCanonicalText(combined, "head-tail");
    const retainedContentBytes = combined.byteLength - projected.omittedBytes;
    return {
      ...projected,
      completeness: "partial",
      omittedBytes: Math.max(0, this.totalBytes - retainedContentBytes),
    };
  }
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
}

function countLines(totalBytes: number, newlines: number, lastByte: number | undefined): number {
  if (totalBytes === 0) return 0;
  return newlines + (lastByte === 0x0a ? 0 : 1);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class StreamingToolOutputCapture implements ToolOutputCapture {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private readonly encoder = new TextEncoder();
  private readonly preview = new PreviewAccumulator();
  private readonly queueMaxBytes: number;
  private readonly queueWaitMs: number;
  private readonly finalizeWaitMs: number;
  private readonly artifactMaxBytes: number;
  private readonly headMaxBytes: number;
  private readonly tailMaxBytes: number;
  private readonly headPath: string;
  private readonly tailPath: string;
  private generation = 1;
  private currentState: CaptureState = "accepting";
  private queuedBytes = 0;
  private discardedBytes = 0;
  private observedBytes = 0;
  private observedNewlines = 0;
  private observedLastByte: number | undefined;
  private canonicalBytes = 0;
  private canonicalNewlines = 0;
  private canonicalLastByte: number | undefined;
  private headBytes = 0;
  private headSealed = false;
  private headNewlines = 0;
  private headLastByte: number | undefined;
  private tailSize = 0;
  private tailPosition = 0;
  private tailWrapped = false;
  private tailPrecedingByte: number | undefined;
  private writerTail: Promise<void> = Promise.resolve();
  private writerFailure: ToolOutputError | undefined;
  private capacityWaiters = new Set<() => void>();
  private completed?: {
    readonly output: CapturedOutput;
    readonly draft: CapturedArtifactDraft;
    readonly generation: number;
  };
  private terminalNotified = false;

  constructor(private readonly options: StreamingCaptureOptions) {
    this.signal = this.controller.signal;
    this.queueMaxBytes = options.queueMaxBytes ?? TOOL_OUTPUT_CAPTURE_QUEUE_MAX_BYTES;
    this.queueWaitMs = options.queueWaitMs ?? TOOL_OUTPUT_CAPTURE_QUEUE_WAIT_MS;
    this.finalizeWaitMs = options.finalizeWaitMs ?? TOOL_OUTPUT_CAPTURE_FINALIZE_WAIT_MS;
    this.artifactMaxBytes = options.artifactMaxBytes ?? TOOL_OUTPUT_ARTIFACT_MAX_BYTES;
    this.headMaxBytes = options.headMaxBytes ?? TOOL_OUTPUT_ARTIFACT_HEAD_MAX_BYTES;
    this.tailMaxBytes = options.tailMaxBytes ?? TOOL_OUTPUT_ARTIFACT_TAIL_MAX_BYTES;
    if (
      this.queueMaxBytes < 4 ||
      this.headMaxBytes + this.tailMaxBytes > this.artifactMaxBytes ||
      this.tailMaxBytes < 4
    ) {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }
    this.headPath = join(options.tempDir, HEAD_PART_FILE);
    this.tailPath = join(options.tempDir, TAIL_RING_FILE);
  }

  get state(): CaptureState {
    return this.currentState;
  }

  async write(chunk: string | Uint8Array): Promise<"accepted" | "discarded"> {
    const raw = typeof chunk === "string" ? this.encoder.encode(chunk) : chunk;
    this.observe(raw);
    if (this.currentState !== "accepting") {
      this.discardedBytes += raw.byteLength;
      return "discarded";
    }

    let offset = 0;
    while (offset < raw.byteLength) {
      const end = Math.min(raw.byteLength, offset + this.queueMaxBytes);
      const part = raw.subarray(offset, end).slice();
      if (!(await this.reserveCapacity(part.byteLength))) {
        this.enterDiscarding();
        this.discardedBytes += raw.byteLength - offset;
        return "discarded";
      }
      if (this.currentState !== "accepting") {
        this.releaseCapacity(part.byteLength);
        this.discardedBytes += raw.byteLength - offset;
        return "discarded";
      }
      this.enqueueReserved(part);
      offset = end;
    }
    return "accepted";
  }

  async complete(): Promise<CapturedOutput> {
    if (this.currentState !== "accepting") {
      const error = this.writerFailure ?? new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
      if (this.currentState === "discarding") await this.abort();
      throw error;
    }
    this.currentState = "finalizing";
    const generation = this.generation;
    this.writerTail = this.writerTail.then(async () => {
      if (!this.isActiveGeneration(generation)) return;
      const trailing = this.decoder.decode();
      if (trailing.length > 0) {
        const redacted = await this.options.input.redactor.push(trailing);
        if (redacted.length > 0) await this.persistCanonical(this.encoder.encode(redacted), generation);
      }
      const finalRedacted = await this.options.input.redactor.finish();
      if (finalRedacted.length > 0) {
        await this.persistCanonical(this.encoder.encode(finalRedacted), generation);
      }
    });
    try {
      const draft = await withTimeout((async () => {
        await this.writerTail;
        if (!this.isActiveGeneration(generation) || this.writerFailure) {
          throw this.writerFailure ?? new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
        }
        return this.materializeDraft(generation);
      })(), this.finalizeWaitMs, () => this.enterDiscarding());
      if (!this.isActiveGeneration(generation)) throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
      const output: CapturedOutput = {
        projection: draft.projection,
        observed: draft.observed,
        canonical: draft.canonical,
        stored: draft.stored,
        omitted: draft.omitted,
        artifactRequired: draft.projection.completeness === "partial",
      };
      this.completed = { output, draft, generation };
      this.currentState = "completed";
      return output;
    } catch (error) {
      this.revoke("aborted");
      await rm(this.options.tempDir, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof ToolOutputError) throw error;
      throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
    }
  }

  async commit(completed: CapturedOutput): Promise<CreatedArtifact> {
    const record = this.completed;
    if (
      this.currentState !== "completed" ||
      !record ||
      record.output !== completed ||
      !completed.artifactRequired
    ) {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }
    this.currentState = "finalizing";
    try {
      const result = await withTimeout(
        this.options.committer.commit(
          record.draft,
          () => this.isActiveGeneration(record.generation),
        ),
        this.finalizeWaitMs,
        () => this.enterDiscarding(),
      );
      if (!this.isActiveGeneration(record.generation)) {
        throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
      }
      this.currentState = "finalized";
      this.notifyTerminal();
      return result;
    } catch (error) {
      this.revoke("aborted");
      await rm(this.options.tempDir, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof ToolOutputError) throw error;
      throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
    }
  }

  async discard(completed: CapturedOutput): Promise<void> {
    const record = this.completed;
    if (this.currentState !== "completed" || !record || record.output !== completed) {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }
    this.revoke("discarded");
    await rm(this.options.tempDir, { recursive: true, force: true });
  }

  async abort(): Promise<void> {
    if (
      this.currentState === "finalized" ||
      this.currentState === "discarded" ||
      this.currentState === "aborted"
    ) return;
    this.revoke("aborted");
    await rm(this.options.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  stats(): CaptureStats {
    return {
      state: this.currentState,
      observedBytes: this.observedBytes,
      observedLines: countLines(this.observedBytes, this.observedNewlines, this.observedLastByte),
      canonicalBytes: this.canonicalBytes,
      canonicalLines: countLines(this.canonicalBytes, this.canonicalNewlines, this.canonicalLastByte),
      queuedBytes: this.queuedBytes,
      discardedBytes: this.discardedBytes,
    };
  }

  private observe(bytes: Uint8Array): void {
    this.observedBytes += bytes.byteLength;
    for (const byte of bytes) if (byte === 0x0a) this.observedNewlines += 1;
    if (bytes.byteLength > 0) this.observedLastByte = bytes[bytes.byteLength - 1];
  }

  private async reserveCapacity(bytes: number): Promise<boolean> {
    const deadline = Date.now() + this.queueWaitMs;
    while (this.currentState === "accepting") {
      // No await between the capacity check and increment: this is the atomic
      // reservation point for all concurrent write() calls in this isolate.
      if (this.queuedBytes + bytes <= this.queueMaxBytes) {
        this.queuedBytes += bytes;
        return true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let release!: () => void;
      const available = new Promise<void>((resolve) => {
        release = resolve;
        this.capacityWaiters.add(resolve);
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          available,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        this.capacityWaiters.delete(release);
      }
    }
    return false;
  }

  private enqueueReserved(raw: Uint8Array): void {
    const generation = this.generation;
    const operation = this.writerTail.then(async () => {
      if (!this.isActiveGeneration(generation)) return;
      const text = this.decoder.decode(raw, { stream: true });
      if (text.length > 0) {
        const redacted = await this.options.input.redactor.push(text);
        if (redacted.length > 0) {
          await this.persistCanonical(this.encoder.encode(redacted), generation);
        }
      }
    });
    this.writerTail = operation
      .catch((error) => {
        this.writerFailure = error instanceof ToolOutputError
          ? error
          : new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
        this.enterDiscarding();
      })
      .finally(() => {
        this.releaseCapacity(raw.byteLength);
      });
  }

  private releaseCapacity(bytes: number): void {
    this.queuedBytes = Math.max(0, this.queuedBytes - bytes);
    for (const waiter of this.capacityWaiters) waiter();
  }

  private async persistCanonical(bytes: Uint8Array, generation: number): Promise<void> {
    if (!this.isActiveGeneration(generation) || bytes.byteLength === 0) return;
    await this.options.beforePersist?.(bytes, this.signal);
    if (!this.isActiveGeneration(generation)) return;
    const previousCanonicalLastByte = this.canonicalLastByte;
    this.canonicalBytes += bytes.byteLength;
    for (const byte of bytes) if (byte === 0x0a) this.canonicalNewlines += 1;
    this.canonicalLastByte = bytes[bytes.byteLength - 1];
    this.preview.append(bytes);

    let offset = 0;
    if (!this.headSealed && this.headBytes < this.headMaxBytes) {
      const maximum = Math.min(bytes.byteLength, this.headMaxBytes - this.headBytes);
      const end = safeUtf8End(bytes, maximum);
      if (end > 0) {
        await appendFile(this.headPath, bytes.subarray(0, end));
        if (!this.isActiveGeneration(generation)) return;
        for (const byte of bytes.subarray(0, end)) if (byte === 0x0a) this.headNewlines += 1;
        this.headLastByte = bytes[end - 1];
        this.headBytes += end;
        offset = end;
      }
      if (offset < bytes.byteLength || this.headBytes >= this.headMaxBytes) {
        this.headSealed = true;
      }
    }
    if (offset < bytes.byteLength) {
      await this.writeTail(
        bytes.subarray(offset),
        generation,
        offset > 0 ? bytes[offset - 1] : previousCanonicalLastByte,
      );
    }
  }

  private async writeTail(
    bytes: Uint8Array,
    generation: number,
    precedingInputByte: number | undefined,
  ): Promise<void> {
    if (!this.isActiveGeneration(generation)) return;
    if (this.tailSize === 0 && this.tailPrecedingByte === undefined) {
      this.tailPrecedingByte = precedingInputByte;
    }
    const capacity = this.canonicalBytes <= this.artifactMaxBytes
      ? this.artifactMaxBytes - this.headBytes
      : this.tailMaxBytes;
    if (this.tailSize > capacity) await this.shrinkTail(capacity);
    let handle;
    let repairWrappedBoundary = false;
    try {
      handle = await open(this.tailPath, "r+");
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      handle = await open(this.tailPath, "w+");
    }
    try {
      if (bytes.byteLength >= capacity) {
        const start = safeUtf8Start(bytes, bytes.byteLength - capacity);
        const retained = bytes.subarray(start);
        this.tailPrecedingByte = start > 0 ? bytes[start - 1] : precedingInputByte;
        await handle.truncate(0);
        await handle.write(retained, 0, retained.byteLength, 0);
        this.tailSize = retained.byteLength;
        this.tailPosition = 0;
        this.tailWrapped = false;
        return;
      }

      let offset = 0;
      if (this.tailSize < capacity) {
        const available = capacity - this.tailSize;
        const length = Math.min(available, bytes.byteLength);
        await handle.write(bytes, offset, length, this.tailSize);
        this.tailSize += length;
        offset += length;
        if (this.tailSize === capacity) this.tailPosition = 0;
      }
      while (offset < bytes.byteLength) {
        const length = Math.min(bytes.byteLength - offset, capacity - this.tailPosition);
        const overwritten = Buffer.allocUnsafe(length);
        const read = await handle.read(overwritten, 0, length, this.tailPosition);
        if (read.bytesRead !== length) throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
        await handle.write(bytes, offset, length, this.tailPosition);
        this.tailPrecedingByte = overwritten[length - 1];
        this.tailPosition = (this.tailPosition + length) % capacity;
        this.tailWrapped = true;
        offset += length;
      }
      if (this.tailWrapped && this.tailSize > 0) {
        const first = Buffer.allocUnsafe(1);
        const result = await handle.read(first, 0, 1, this.tailPosition);
        if (result.bytesRead !== 1) throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
        repairWrappedBoundary = (first[0]! & 0xc0) === 0x80;
      }
    } finally {
      await handle.close();
    }
    if (repairWrappedBoundary) await this.shrinkTail(capacity);
  }

  private async shrinkTail(capacity: number): Promise<void> {
    const raw = new Uint8Array(await readFile(this.tailPath));
    const ordered = this.tailWrapped
      ? concatBytes(raw.subarray(this.tailPosition), raw.subarray(0, this.tailPosition))
      : raw.subarray(0, this.tailSize);
    const start = safeUtf8Start(ordered, Math.max(0, ordered.byteLength - capacity));
    const retained = ordered.subarray(start);
    if (start > 0) this.tailPrecedingByte = ordered[start - 1];
    await writeFile(this.tailPath, retained);
    this.tailSize = retained.byteLength;
    this.tailPosition = 0;
    this.tailWrapped = false;
  }

  private async materializeDraft(generation: number): Promise<CapturedArtifactDraft> {
    if (!this.isActiveGeneration(generation)) throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
    const complete =
      this.canonicalBytes <= this.artifactMaxBytes &&
      this.headBytes + this.tailSize === this.canonicalBytes;
    let segments: ArtifactSegmentMetadata[];
    let storedBytes: number;
    let storedLines: number;
    let tailNewlines = 0;

    if (complete) {
      const bodyPath = join(this.options.tempDir, "body.txt");
      const target = await open(bodyPath, "w");
      try {
        await copyPath(this.headPath, target, 0);
        await this.copyOrderedTail(target, this.headBytes);
      } finally {
        await target.close();
      }
      await rm(this.headPath, { force: true });
      await rm(this.tailPath, { force: true });
      storedBytes = this.canonicalBytes;
      storedLines = countLines(this.canonicalBytes, this.canonicalNewlines, this.canonicalLastByte);
      segments = [{
        kind: "full",
        fileName: "body.txt",
        canonicalStart: 0,
        canonicalEnd: storedBytes,
        bytes: storedBytes,
        lines: storedLines,
      }];
    } else {
      const headPath = join(this.options.tempDir, "head.txt");
      await rename(this.headPath, headPath);
      const tailPath = join(this.options.tempDir, "tail.txt");
      const target = await open(tailPath, "w");
      let tailStats: { bytes: number; lines: number; newlines: number };
      try {
        tailStats = await this.copyOrderedTail(target, 0);
      } finally {
        await target.close();
      }
      await rm(this.tailPath, { force: true });
      tailNewlines = tailStats.newlines;
      const tailStart = this.canonicalBytes - tailStats.bytes;
      const headLines = countLines(this.headBytes, this.headNewlines, this.headLastByte);
      storedBytes = this.headBytes + tailStats.bytes;
      storedLines = headLines + tailStats.lines;
      segments = [
        {
          kind: "head",
          fileName: "head.txt",
          canonicalStart: 0,
          canonicalEnd: this.headBytes,
          bytes: this.headBytes,
          lines: headLines,
        },
        {
          kind: "tail",
          fileName: "tail.txt",
          canonicalStart: tailStart,
          canonicalEnd: this.canonicalBytes,
          bytes: tailStats.bytes,
          lines: tailStats.lines,
        },
      ];
    }

    const observedLines = countLines(this.observedBytes, this.observedNewlines, this.observedLastByte);
    const canonicalLines = countLines(this.canonicalBytes, this.canonicalNewlines, this.canonicalLastByte);
    const omittedBytes = this.canonicalBytes - storedBytes;
    return {
      tempDir: this.options.tempDir,
      owner: this.options.input.owner,
      observed: { bytes: this.observedBytes, lines: observedLines },
      canonical: { bytes: this.canonicalBytes, lines: canonicalLines },
      stored: { bytes: storedBytes, lines: storedLines },
      omitted: {
        bytes: omittedBytes,
        lines: omittedBytes === 0
          ? 0
          : countLines(
              omittedBytes,
              Math.max(0, this.canonicalNewlines - this.headNewlines - tailNewlines),
              this.tailPrecedingByte,
            ),
      },
      segments,
      projection: this.preview.project(this.options.input.previewDirection ?? "head-tail"),
    };
  }

  private async copyOrderedTail(
    target: Awaited<ReturnType<typeof open>>,
    targetStart: number,
  ): Promise<{ bytes: number; lines: number; newlines: number }> {
    if (this.tailSize === 0) return { bytes: 0, lines: 0, newlines: 0 };
    const source = await open(this.tailPath, "r");
    const ranges = this.tailWrapped
      ? [
          { start: this.tailPosition, length: this.tailSize - this.tailPosition },
          { start: 0, length: this.tailPosition },
        ]
      : [{ start: 0, length: this.tailSize }];
    let written = 0;
    let newlines = 0;
    let lastByte: number | undefined;
    try {
      for (const range of ranges) {
        let consumed = 0;
        while (consumed < range.length) {
          const length = Math.min(COPY_CHUNK_BYTES, range.length - consumed);
          const buffer = Buffer.allocUnsafe(length);
          const result = await source.read(buffer, 0, length, range.start + consumed);
          if (result.bytesRead !== length) throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
          await target.write(buffer, 0, length, targetStart + written);
          for (const byte of buffer) if (byte === 0x0a) newlines += 1;
          lastByte = buffer[buffer.byteLength - 1];
          consumed += length;
          written += length;
        }
      }
    } finally {
      await source.close();
    }
    return { bytes: written, lines: countLines(written, newlines, lastByte), newlines };
  }

  private isActiveGeneration(generation: number): boolean {
    return this.generation === generation &&
      (this.currentState === "accepting" ||
        this.currentState === "finalizing" ||
        this.currentState === "completed");
  }

  private enterDiscarding(): void {
    if (
      this.currentState === "finalized" ||
      this.currentState === "discarded" ||
      this.currentState === "aborted"
    ) return;
    this.revoke("discarding");
    void rm(this.options.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private revoke(state: "discarding" | "discarded" | "aborted"): void {
    this.generation += 1;
    this.currentState = state;
    this.controller.abort();
    this.options.input.redactor.abort?.();
    for (const waiter of this.capacityWaiters) waiter();
    this.notifyTerminal();
  }

  private notifyTerminal(): void {
    if (this.terminalNotified) return;
    this.terminalNotified = true;
    this.options.onTerminal?.();
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function copyPath(
  path: string,
  target: Awaited<ReturnType<typeof open>>,
  targetStart: number,
): Promise<number> {
  if (!(await Bun.file(path).exists())) return 0;
  const source = await open(path, "r");
  let offset = 0;
  try {
    const size = (await source.stat()).size;
    while (offset < size) {
      const length = Math.min(COPY_CHUNK_BYTES, size - offset);
      const buffer = Buffer.allocUnsafe(length);
      const result = await source.read(buffer, 0, length, offset);
      if (result.bytesRead !== length) throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
      await target.write(buffer, 0, length, targetStart + offset);
      offset += length;
    }
    return offset;
  } finally {
    await source.close();
  }
}
