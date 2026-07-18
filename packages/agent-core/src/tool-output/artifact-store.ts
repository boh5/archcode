import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  TOOL_OUTPUT_ARTIFACT_HEAD_MAX_BYTES,
  TOOL_OUTPUT_ARTIFACT_MAX_BYTES,
  TOOL_OUTPUT_ARTIFACT_TAIL_MAX_BYTES,
  TOOL_OUTPUT_BODY_TTL_MS,
  TOOL_OUTPUT_FAMILY_LEASE_MAX_GLOBAL,
  TOOL_OUTPUT_FAMILY_LEASE_MAX_PER_FAMILY,
  TOOL_OUTPUT_FAMILY_LEASE_MAX_PINNED_REFS,
  TOOL_OUTPUT_FAMILY_LEASE_MAX_REFS,
  TOOL_OUTPUT_FAMILY_LEASE_TTL_MS,
  TOOL_OUTPUT_CLEANUP_INTERVAL_MS,
  TOOL_OUTPUT_METADATA_MAX_BYTES,
  TOOL_OUTPUT_LEDGER_MAX_BYTES,
  TOOL_OUTPUT_LEDGER_MAX_ENTRIES,
  TOOL_OUTPUT_READ_DEFAULT_RECORDS,
  TOOL_OUTPUT_READ_MAX_BYTES,
  TOOL_OUTPUT_READ_MAX_RECORDS,
  TOOL_OUTPUT_SEARCH_DEFAULT_MATCHES,
  TOOL_OUTPUT_SEARCH_MAX_BYTES,
  TOOL_OUTPUT_SEARCH_MAX_MATCHES,
  TOOL_OUTPUT_SEARCH_PATTERN_MAX_BYTES,
  TOOL_OUTPUT_SEARCH_SNIPPET_MAX_BYTES,
  TOOL_OUTPUT_SEARCH_TIMEOUT_MS,
  TOOL_OUTPUT_STALE_TEMP_MS,
  TOOL_OUTPUT_BODY_MAX_ACTIVE,
  TOOL_OUTPUT_BODY_QUOTA_BYTES,
  TOOL_OUTPUT_TOMBSTONE_TTL_MS,
} from "./constants";
import { ToolOutputError } from "./errors";
import { projectCanonicalText } from "./projection";
import { createOutputRef, isOutputRef, OpaqueCursorCodec } from "./ref";
import { RipgrepArtifactSearchRunner } from "./ripgrep-search-runner";
import {
  StreamingToolOutputCapture,
  type BeginCaptureInput,
  type CapturedArtifactDraft,
  type ToolOutputCapture,
} from "./capture";
import type {
  ArtifactAuthorizationScope,
  ArtifactMetadata,
  ArtifactOwner,
  ArtifactPublicMetadata,
  ArtifactSearchRunner,
  ArtifactSearchRunnerMatch,
  ArtifactSegmentKind,
  ArtifactSegmentMetadata,
  ArtifactTombstone,
  ArtifactTombstoneReason,
  CreateArtifactInput,
  CreatedArtifact,
  OutputReadInput,
  OutputReadPage,
  OutputReadRecord,
  OutputRef,
  OutputSearchInput,
  OutputSearchPage,
} from "./artifact-types";
import {
  canonicalizeUtf8,
  countUtf8Lines,
  decodeUtf8,
  safeUtf8End,
  safeUtf8Start,
  utf8ByteLength,
} from "./utf8";

const ARTIFACTS_DIRECTORY = "artifacts";
const TOMBSTONES_DIRECTORY = "tombstones";
const CURSOR_KEY_FILE = "cursor.key";
const TEMP_PREFIX = ".tmp-";
const METADATA_FILE = "metadata.json";

export interface ArtifactStoreLimits {
  readonly artifactMaxBytes: number;
  readonly artifactHeadMaxBytes: number;
  readonly artifactTailMaxBytes: number;
  readonly bodyQuotaBytes: number;
  readonly bodyMaxActive: number;
  readonly ledgerMaxEntries: number;
  readonly ledgerMaxBytes: number;
  readonly bodyTtlMs: number;
  readonly tombstoneTtlMs: number;
  readonly cleanupIntervalMs: number;
  readonly staleTempMs: number;
  readonly readMaxBytes: number;
  readonly readMaxRecords: number;
  readonly familyLeaseTtlMs: number;
  readonly familyLeaseMaxRefs: number;
  readonly familyLeaseMaxGlobal: number;
  readonly familyLeaseMaxPerFamily: number;
  readonly familyLeaseMaxPinnedRefs: number;
}

const DEFAULT_LIMITS: ArtifactStoreLimits = {
  artifactMaxBytes: TOOL_OUTPUT_ARTIFACT_MAX_BYTES,
  artifactHeadMaxBytes: TOOL_OUTPUT_ARTIFACT_HEAD_MAX_BYTES,
  artifactTailMaxBytes: TOOL_OUTPUT_ARTIFACT_TAIL_MAX_BYTES,
  bodyQuotaBytes: TOOL_OUTPUT_BODY_QUOTA_BYTES,
  bodyMaxActive: TOOL_OUTPUT_BODY_MAX_ACTIVE,
  ledgerMaxEntries: TOOL_OUTPUT_LEDGER_MAX_ENTRIES,
  ledgerMaxBytes: TOOL_OUTPUT_LEDGER_MAX_BYTES,
  bodyTtlMs: TOOL_OUTPUT_BODY_TTL_MS,
  tombstoneTtlMs: TOOL_OUTPUT_TOMBSTONE_TTL_MS,
  cleanupIntervalMs: TOOL_OUTPUT_CLEANUP_INTERVAL_MS,
  staleTempMs: TOOL_OUTPUT_STALE_TEMP_MS,
  readMaxBytes: TOOL_OUTPUT_READ_MAX_BYTES,
  readMaxRecords: TOOL_OUTPUT_READ_MAX_RECORDS,
  familyLeaseTtlMs: TOOL_OUTPUT_FAMILY_LEASE_TTL_MS,
  familyLeaseMaxRefs: TOOL_OUTPUT_FAMILY_LEASE_MAX_REFS,
  familyLeaseMaxGlobal: TOOL_OUTPUT_FAMILY_LEASE_MAX_GLOBAL,
  familyLeaseMaxPerFamily: TOOL_OUTPUT_FAMILY_LEASE_MAX_PER_FAMILY,
  familyLeaseMaxPinnedRefs: TOOL_OUTPUT_FAMILY_LEASE_MAX_PINNED_REFS,
};

export interface ArtifactStoreOptions {
  readonly rootDir: string;
  readonly searchRunner?: ArtifactSearchRunner;
  readonly cursorKey?: Uint8Array;
  readonly now?: () => number;
  /** Internal dependency seam for deterministic tests; Runtime config must not expose it. */
  readonly limits?: Partial<ArtifactStoreLimits>;
  /** Internal file-handle seam for bounded-read and short-read tests. */
  readonly openReadHandle?: (path: string) => Promise<ArtifactReadHandle>;
}

interface ArtifactReadHandle {
  stat(): Promise<{ readonly size: number }>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

interface IndexedArtifact {
  metadata: ArtifactMetadata;
  bodyBytes: number;
  ledgerBytes: number;
}

interface IndexedTombstone {
  tombstone: ArtifactTombstone;
  ledgerBytes: number;
}

interface ReadCursorPayload {
  readonly v: 1;
  readonly kind: "read";
  readonly projectIdentity: string;
  readonly rootSessionId: string;
  readonly outputRef: OutputRef;
  readonly segmentIndex: number;
  readonly offset: number;
}

interface SearchCursorPayload {
  readonly v: 1;
  readonly kind: "search";
  readonly projectIdentity: string;
  readonly rootSessionId: string;
  readonly outputRef: OutputRef;
  readonly patternDigest: string;
  readonly runnerCursor: string;
}

interface FamilySearchCursorPayload {
  readonly v: 1;
  readonly kind: "family-search";
  readonly projectIdentity: string;
  readonly rootSessionId: string;
  readonly patternDigest: string;
  readonly leaseId: string;
  readonly artifactIndex: number;
  readonly artifactCursor?: string;
}

interface FamilySearchLease {
  readonly id: string;
  readonly projectIdentity: string;
  readonly rootSessionId: string;
  readonly patternDigest: string;
  readonly refs: readonly OutputRef[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function mergeLimits(input: Partial<ArtifactStoreLimits> | undefined): ArtifactStoreLimits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  const positive = Object.values(limits).every(
    (value) => Number.isSafeInteger(value) && value > 0,
  );
  if (
    !positive ||
    limits.artifactHeadMaxBytes + limits.artifactTailMaxBytes > limits.artifactMaxBytes
  ) {
    throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
  }
  return limits;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && utf8ByteLength(value) <= 128;
}

function isOwner(value: unknown): value is ArtifactOwner {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.projectIdentity === "string" &&
    /^[a-f0-9]{64}$/.test(value.projectIdentity) &&
    isBoundedIdentifier(value.rootSessionId) &&
    isBoundedIdentifier(value.producerSessionId) &&
    Object.keys(value).length === 3
  );
}

function isStat(value: unknown): value is { bytes: number; lines: number } {
  if (!isPlainObject(value) || Object.keys(value).length !== 2) return false;
  return (
    Number.isSafeInteger(value.bytes) &&
    (value.bytes as number) >= 0 &&
    Number.isSafeInteger(value.lines) &&
    (value.lines as number) >= 0
  );
}

const SEGMENT_FILES = new Set(["body.txt", "head.txt", "tail.txt"]);
const SEGMENT_KINDS = new Set(["full", "head", "tail"]);

function isSegment(value: unknown): value is ArtifactSegmentMetadata {
  if (!isPlainObject(value) || Object.keys(value).length !== 6) return false;
  return (
    SEGMENT_KINDS.has(String(value.kind)) &&
    SEGMENT_FILES.has(String(value.fileName)) &&
    Number.isSafeInteger(value.canonicalStart) &&
    (value.canonicalStart as number) >= 0 &&
    Number.isSafeInteger(value.canonicalEnd) &&
    (value.canonicalEnd as number) >= (value.canonicalStart as number) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes === (value.canonicalEnd as number) - (value.canonicalStart as number) &&
    Number.isSafeInteger(value.lines) &&
    (value.lines as number) >= 0
  );
}

function parseMetadata(value: unknown): ArtifactMetadata | undefined {
  if (!isPlainObject(value) || Object.keys(value).length !== 12) return undefined;
  if (
    value.version !== 1 ||
    !isOutputRef(value.outputRef) ||
    !isOwner(value.owner) ||
    !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    !Number.isSafeInteger(value.lastAccessedAt) ||
    (value.completeness !== "complete" && value.completeness !== "partial") ||
    !isStat(value.observed) ||
    !isStat(value.canonical) ||
    !isStat(value.stored) ||
    !isStat(value.omitted) ||
    !Array.isArray(value.segments) ||
    value.segments.length < 1 ||
    value.segments.length > 2 ||
    !value.segments.every(isSegment)
  ) {
    return undefined;
  }
  if (
    (value.expiresAt as number) < (value.createdAt as number) ||
    (value.lastAccessedAt as number) < (value.createdAt as number) ||
    (value.canonical as { bytes: number }).bytes !==
      (value.stored as { bytes: number }).bytes + (value.omitted as { bytes: number }).bytes
  ) {
    return undefined;
  }
  const segments = value.segments as ArtifactSegmentMetadata[];
  const canonical = value.canonical as { bytes: number; lines: number };
  const stored = value.stored as { bytes: number; lines: number };
  const omitted = value.omitted as { bytes: number; lines: number };
  const segmentBytes = segments.reduce((sum, segment) => sum + segment.bytes, 0);
  const segmentLines = segments.reduce((sum, segment) => sum + segment.lines, 0);
  if (segmentBytes !== stored.bytes || segmentLines !== stored.lines) return undefined;
  if (value.completeness === "complete") {
    const only = segments[0];
    if (
      segments.length !== 1 ||
      only?.kind !== "full" ||
      only.fileName !== "body.txt" ||
      only.canonicalStart !== 0 ||
      only.canonicalEnd !== canonical.bytes ||
      omitted.bytes !== 0 ||
      omitted.lines !== 0
    ) {
      return undefined;
    }
  } else {
    const head = segments[0];
    const tail = segments[1];
    if (
      segments.length !== 2 ||
      head?.kind !== "head" ||
      head.fileName !== "head.txt" ||
      head.canonicalStart !== 0 ||
      tail?.kind !== "tail" ||
      tail.fileName !== "tail.txt" ||
      head.canonicalEnd > tail.canonicalStart ||
      tail.canonicalEnd !== canonical.bytes ||
      omitted.bytes !== tail.canonicalStart - head.canonicalEnd ||
      omitted.bytes <= 0
    ) {
      return undefined;
    }
  }
  return value as unknown as ArtifactMetadata;
}

function parseTombstone(value: unknown): ArtifactTombstone | undefined {
  if (!isPlainObject(value) || Object.keys(value).length !== 6) return undefined;
  if (
    value.version !== 1 ||
    !isOutputRef(value.outputRef) ||
    !isOwner(value.owner) ||
    !Number.isSafeInteger(value.deletedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    ((value.reason as ArtifactTombstoneReason) !== "expired" && value.reason !== "evicted") ||
    (value.expiresAt as number) < (value.deletedAt as number)
  ) {
    return undefined;
  }
  return value as unknown as ArtifactTombstone;
}

function publicMetadata(metadata: ArtifactMetadata): ArtifactPublicMetadata {
  return {
    outputRef: metadata.outputRef,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt,
    completeness: metadata.completeness,
    observed: metadata.observed,
    canonical: metadata.canonical,
    stored: metadata.stored,
    omitted: metadata.omitted,
  };
}

function ownersMatch(owner: ArtifactOwner, scope: ArtifactAuthorizationScope): boolean {
  return (
    owner.projectIdentity === scope.projectIdentity &&
    owner.rootSessionId === scope.rootSessionId
  );
}

function patternDigest(pattern: string): string {
  return createHash("sha256").update(pattern, "utf8").digest("hex");
}

async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${TEMP_PREFIX}${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readBoundedJson(path: string): Promise<unknown> {
  const info = await stat(path);
  if (info.size > TOOL_OUTPUT_METADATA_MAX_BYTES) {
    throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
  }
  return JSON.parse(await readFile(path, "utf8"));
}

function assertOwner(owner: ArtifactOwner): void {
  if (!isOwner(owner)) throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
}

function assertScope(scope: ArtifactAuthorizationScope): void {
  if (
    typeof scope.projectIdentity !== "string" ||
    !/^[a-f0-9]{64}$/.test(scope.projectIdentity) ||
    !isBoundedIdentifier(scope.rootSessionId)
  ) {
    throw new ToolOutputError("TOOL_OUTPUT_FORBIDDEN");
  }
}

function assertPattern(pattern: string): void {
  if (
    pattern.length === 0 ||
    pattern.includes("\r") ||
    pattern.includes("\n") ||
    utf8ByteLength(pattern) > TOOL_OUTPUT_SEARCH_PATTERN_MAX_BYTES
  ) {
    throw new ToolOutputError("TOOL_OUTPUT_INVALID_PATTERN");
  }
}

function isReadCursor(value: unknown): value is ReadCursorPayload {
  if (!isPlainObject(value) || Object.keys(value).length !== 7) return false;
  return (
    value.v === 1 &&
    value.kind === "read" &&
    typeof value.projectIdentity === "string" &&
    typeof value.rootSessionId === "string" &&
    isOutputRef(value.outputRef) &&
    Number.isSafeInteger(value.segmentIndex) &&
    (value.segmentIndex as number) >= 0 &&
    Number.isSafeInteger(value.offset) &&
    (value.offset as number) >= 0
  );
}

function isSearchCursor(value: unknown): value is SearchCursorPayload {
  if (!isPlainObject(value) || Object.keys(value).length !== 7) return false;
  return (
    value.v === 1 &&
    value.kind === "search" &&
    typeof value.projectIdentity === "string" &&
    typeof value.rootSessionId === "string" &&
    isOutputRef(value.outputRef) &&
    typeof value.patternDigest === "string" &&
    /^[a-f0-9]{64}$/.test(value.patternDigest) &&
    typeof value.runnerCursor === "string" &&
    utf8ByteLength(value.runnerCursor) <= 4 * 1024
  );
}

function isFamilySearchCursor(value: unknown): value is FamilySearchCursorPayload {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 7 && keys.length !== 8) return false;
  return (
    value.v === 1 &&
    value.kind === "family-search" &&
    typeof value.projectIdentity === "string" &&
    typeof value.rootSessionId === "string" &&
    typeof value.patternDigest === "string" &&
    /^[a-f0-9]{64}$/.test(value.patternDigest) &&
    typeof value.leaseId === "string" &&
    /^[A-Za-z0-9_-]{22}$/.test(value.leaseId) &&
    Number.isSafeInteger(value.artifactIndex) &&
    (value.artifactIndex as number) >= 0 &&
    (value.artifactCursor === undefined ||
      (typeof value.artifactCursor === "string" && utf8ByteLength(value.artifactCursor) <= 4 * 1024))
  );
}

export async function computeProjectIdentity(workspaceRoot: string): Promise<string> {
  const canonicalRoot = await realpath(workspaceRoot);
  return createHash("sha256").update(canonicalRoot, "utf8").digest("hex");
}

export class ToolOutputArtifactStore {
  private readonly rootDir: string;
  private readonly artifactsDir: string;
  private readonly tombstonesDir: string;
  private readonly limits: ArtifactStoreLimits;
  private readonly now: () => number;
  private readonly searchRunner: ArtifactSearchRunner;
  private readonly openReadHandle: (path: string) => Promise<ArtifactReadHandle>;
  private readonly mutex = new AsyncMutex();
  private readonly artifacts = new Map<OutputRef, IndexedArtifact>();
  private readonly tombstones = new Map<OutputRef, IndexedTombstone>();
  private readonly inUse = new Map<OutputRef, number>();
  private readonly leases = new Map<string, FamilySearchLease>();
  private readonly pinnedRefs = new Map<OutputRef, number>();
  private readonly activeCaptures = new Map<string, ToolOutputCapture>();
  private readonly initialization: Promise<void>;
  private cursorCodec?: OpaqueCursorCodec;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(private readonly options: ArtifactStoreOptions) {
    this.rootDir = options.rootDir;
    this.artifactsDir = join(this.rootDir, ARTIFACTS_DIRECTORY);
    this.tombstonesDir = join(this.rootDir, TOMBSTONES_DIRECTORY);
    this.limits = mergeLimits(options.limits);
    this.now = options.now ?? Date.now;
    this.searchRunner = options.searchRunner ?? new RipgrepArtifactSearchRunner();
    this.openReadHandle = options.openReadHandle ?? ((path) => open(path, "r"));
    this.initialization = this.initialize(options.cursorKey);
  }

  async ready(): Promise<void> {
    await this.initialization;
  }

  /** Test-fixture seam only; production artifact creation enters through beginCapture. */
  private async createFixtureArtifact(input: CreateArtifactInput): Promise<CreatedArtifact> {
    await this.assertReady();
    assertOwner(input.owner);
    const canonical = canonicalizeUtf8(input.canonical);
    const projection = projectCanonicalText(
      canonical.bytes,
      input.previewDirection ?? "head-tail",
    );
    const createdAt = this.now();

    return this.mutex.withLock(async () => {
      const outputRef = await this.allocateOutputRef();
      const segments = this.selectSegments(canonical.bytes);
      const storedBytes = segments.reduce((sum, item) => sum + item.bytes.byteLength, 0);
      const storedLines = segments.reduce((sum, item) => sum + countUtf8Lines(item.bytes), 0);
      const omittedBytes = canonical.bytes.byteLength - storedBytes;
      const omittedLines = omittedBytes === 0
        ? 0
        : countUtf8Lines(
            canonical.bytes.subarray(segments[0]!.bytes.byteLength, segments.at(-1)!.start),
          );
      const metadata: ArtifactMetadata = {
        version: 1,
        outputRef,
        owner: input.owner,
        createdAt,
        expiresAt: createdAt + this.limits.bodyTtlMs,
        lastAccessedAt: createdAt,
        completeness: omittedBytes === 0 ? "complete" : "partial",
        observed: {
          bytes: input.observedBytes ?? canonical.observedBytes,
          lines: input.observedLines ?? canonical.canonicalLines,
        },
        canonical: { bytes: canonical.canonicalBytes, lines: canonical.canonicalLines },
        stored: { bytes: storedBytes, lines: storedLines },
        omitted: { bytes: omittedBytes, lines: omittedLines },
        segments: segments.map((segment) => ({
          kind: segment.kind,
          fileName: segment.fileName,
          canonicalStart: segment.start,
          canonicalEnd: segment.start + segment.bytes.byteLength,
          bytes: segment.bytes.byteLength,
          lines: countUtf8Lines(segment.bytes),
        })),
      };

      const tempDir = join(this.rootDir, `${TEMP_PREFIX}${crypto.randomUUID()}`);
      const finalDir = this.artifactPath(outputRef);
      try {
        await mkdir(tempDir, { recursive: false });
        for (const segment of segments) {
          await writeFile(join(tempDir, segment.fileName), segment.bytes);
        }
        const serialized = JSON.stringify(metadata);
        if (utf8ByteLength(serialized) > TOOL_OUTPUT_METADATA_MAX_BYTES) {
          throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
        }
        await this.cleanupLocked();
        this.assertLedgerAdmission(utf8ByteLength(serialized), 1);
        await writeFile(join(tempDir, METADATA_FILE), serialized);
        await rename(tempDir, finalDir);
        this.artifacts.set(outputRef, {
          metadata,
          bodyBytes: storedBytes,
          ledgerBytes: utf8ByteLength(serialized),
        });
        await this.enforceQuotaLocked(new Set([outputRef]));
        if (
          this.artifacts.size > this.limits.bodyMaxActive ||
          this.totalBodyBytes() > this.limits.bodyQuotaBytes
        ) {
          await this.removeArtifactLocked(outputRef, "evicted");
        }
        if (!this.artifacts.has(outputRef)) {
          throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
        }
        return { outputRef, metadata: publicMetadata(metadata), projection };
      } catch (error) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        if (this.artifacts.has(outputRef)) {
          await this.removeArtifactLocked(outputRef, undefined);
        }
        if (error instanceof ToolOutputError) throw error;
        throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
      }
    });
  }

  async beginCapture(input: BeginCaptureInput): Promise<ToolOutputCapture> {
    await this.assertReady();
    assertOwner(input.owner);
    const tempDir = join(this.rootDir, `${TEMP_PREFIX}${crypto.randomUUID()}`);
    await mkdir(tempDir, { recursive: false });
    const capture = new StreamingToolOutputCapture({
      tempDir,
      input,
      artifactMaxBytes: this.limits.artifactMaxBytes,
      headMaxBytes: this.limits.artifactHeadMaxBytes,
      tailMaxBytes: this.limits.artifactTailMaxBytes,
      committer: {
        commit: (draft, generationIsActive) =>
          this.commitCapturedArtifact(draft, generationIsActive),
      },
      onTerminal: () => this.activeCaptures.delete(tempDir),
    });
    this.activeCaptures.set(tempDir, capture);
    return capture;
  }

  async read(input: OutputReadInput): Promise<OutputReadPage> {
    await this.assertReady();
    assertScope(input);
    const outputRef = this.requireRef(input.outputRef);
    const limit = input.limit ?? TOOL_OUTPUT_READ_DEFAULT_RECORDS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.limits.readMaxRecords) {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }
    const maxContentBytes = input.maxContentBytes ?? this.limits.readMaxBytes;
    if (
      !Number.isSafeInteger(maxContentBytes) ||
      maxContentBytes < 4 ||
      maxContentBytes > this.limits.readMaxBytes
    ) {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }

    const entry = await this.acquire(outputRef, input);
    try {
      let segmentIndex = 0;
      let offset = 0;
      if (input.cursor !== undefined) {
        const payload = this.cursor().decode(input.cursor);
        if (!isReadCursor(payload) || !this.cursorScopeMatches(payload, input, outputRef)) {
          throw new ToolOutputError("TOOL_OUTPUT_INVALID_CURSOR");
        }
        segmentIndex = payload.segmentIndex;
        offset = payload.offset;
      }
      if (segmentIndex > entry.metadata.segments.length) {
        throw new ToolOutputError("TOOL_OUTPUT_INVALID_CURSOR");
      }
      if (segmentIndex === entry.metadata.segments.length && offset !== 0) {
        throw new ToolOutputError("TOOL_OUTPUT_INVALID_CURSOR");
      }

      const records: OutputReadRecord[] = [];
      let contentBytes = 0;
      readSegments: while (
        segmentIndex < entry.metadata.segments.length &&
        records.length < limit &&
        contentBytes < maxContentBytes
      ) {
        const segment = entry.metadata.segments[segmentIndex]!;
        let handle: ArtifactReadHandle | undefined;
        try {
          handle = await this.openReadHandle(
            join(this.artifactPath(outputRef), segment.fileName),
          );
          const info = await handle.stat();
          if (
            !Number.isSafeInteger(info.size) ||
            info.size !== segment.bytes ||
            offset > segment.bytes
          ) {
            throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
          }
          if (offset === segment.bytes) {
            segmentIndex += 1;
            offset = 0;
            continue;
          }

          while (
            offset < segment.bytes &&
            records.length < limit &&
            contentBytes < maxContentBytes
          ) {
            const remainingBudget = maxContentBytes - contentBytes;
            const previousByteCount = offset > 0 ? 1 : 0;
            // Three lookahead bytes are enough to detect a split four-byte
            // UTF-8 code point while retaining only one response page.
            const contentWindowBytes = Math.min(
              segment.bytes - offset,
              remainingBudget + 3,
            );
            const window = await this.readWindow(
              handle,
              offset - previousByteCount,
              previousByteCount + contentWindowBytes,
            );
            if (window.byteLength !== previousByteCount + contentWindowBytes) {
              throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
            }
            const body = window.subarray(previousByteCount);
            const newlineIndex = body.indexOf(0x0a);
            const lineEnd = newlineIndex === -1 ? body.byteLength : newlineIndex + 1;
            const end = safeUtf8End(body, Math.min(lineEnd, remainingBudget));
            if (end === 0) break readSegments;
            const textBytes = body.subarray(0, end);
            const canonicalStart = segment.canonicalStart + offset;
            const canonicalEnd = canonicalStart + end;
            records.push({
              segment: segment.kind,
              canonicalStart,
              canonicalEnd,
              text: decodeUtf8(textBytes),
              continuedFromPrevious:
                (previousByteCount === 1 && window[0] !== 0x0a) ||
                (offset === 0 && segment.canonicalStart > 0),
              continuesNext:
                newlineIndex === -1
                  ? offset + end < segment.bytes
                  : end < lineEnd,
            });
            contentBytes += textBytes.byteLength;
            offset += end;
          }
          if (offset === segment.bytes) {
            segmentIndex += 1;
            offset = 0;
          }
        } catch (error) {
          if (error instanceof ToolOutputError) throw error;
          throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
        } finally {
          await handle?.close().catch(() => undefined);
        }
      }

      const nextCursor = segmentIndex < entry.metadata.segments.length
        ? this.cursor().encode({
            v: 1,
            kind: "read",
            projectIdentity: input.projectIdentity,
            rootSessionId: input.rootSessionId,
            outputRef,
            segmentIndex,
            offset,
          })
        : undefined;
      const first = entry.metadata.segments[0]!;
      const last = entry.metadata.segments.at(-1)!;
      const gap = entry.metadata.completeness === "partial"
        ? { canonicalStart: first.canonicalEnd, canonicalEnd: last.canonicalStart }
        : undefined;
      return {
        outputRef,
        completeness: entry.metadata.completeness,
        records,
        nextCursor,
        gap,
      };
    } finally {
      this.release(outputRef);
    }
  }

  async search(input: OutputSearchInput): Promise<OutputSearchPage> {
    if (input.outputRef === undefined) return this.searchFamily(input);
    return this.searchSingle(input as OutputSearchInput & { outputRef: string });
  }

  private async searchSingle(
    input: OutputSearchInput & { outputRef: string },
    execution?: { readonly deadlineAt: number; readonly maxContentBytes: number },
  ): Promise<OutputSearchPage> {
    await this.assertReady();
    assertScope(input);
    assertPattern(input.pattern);
    const outputRef = this.requireRef(input.outputRef);
    const limit = input.limit ?? TOOL_OUTPUT_SEARCH_DEFAULT_MATCHES;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > TOOL_OUTPUT_SEARCH_MAX_MATCHES) {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }
    const maxContentBytes = execution?.maxContentBytes
      ?? input.maxContentBytes
      ?? TOOL_OUTPUT_SEARCH_MAX_BYTES;
    if (
      !Number.isSafeInteger(maxContentBytes) ||
      maxContentBytes < TOOL_OUTPUT_SEARCH_SNIPPET_MAX_BYTES ||
      maxContentBytes > TOOL_OUTPUT_SEARCH_MAX_BYTES
    ) {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }

    let runnerCursor: string | undefined;
    if (input.cursor !== undefined) {
      const payload = this.cursor().decode(input.cursor);
      if (
        !isSearchCursor(payload) ||
        !this.cursorScopeMatches(payload, input, outputRef) ||
        payload.patternDigest !== patternDigest(input.pattern)
      ) {
        throw new ToolOutputError("TOOL_OUTPUT_INVALID_CURSOR");
      }
      runnerCursor = payload.runnerCursor;
    }

    const entry = await this.acquire(outputRef, input);
    const controller = new AbortController();
    const deadlineAt = execution?.deadlineAt ?? this.now() + TOOL_OUTPUT_SEARCH_TIMEOUT_MS;
    const timeoutMs = Math.max(1, deadlineAt - this.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ToolOutputError("TOOL_OUTPUT_SEARCH_TIMEOUT"));
        }, timeoutMs);
      });
      const result = await Promise.race([
        this.searchRunner.search({
          segments: entry.metadata.segments.map((segment) => ({
            kind: segment.kind,
            path: join(this.artifactPath(outputRef), segment.fileName),
            canonicalStart: segment.canonicalStart,
            canonicalEnd: segment.canonicalEnd,
          })),
          pattern: input.pattern,
          cursor: runnerCursor,
          limit,
          maxContentBytes,
          deadlineAt,
          signal: controller.signal,
        }),
        timeout,
      ]);
      await this.assertStillActive(outputRef, input);
      this.validateSearchResult(
        entry.metadata,
        result.matches,
        limit,
        maxContentBytes,
      );
      if (result.nextCursor !== undefined && utf8ByteLength(result.nextCursor) > 4 * 1024) {
        throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
      }
      const nextCursor = result.nextCursor === undefined
        ? undefined
        : this.cursor().encode({
            v: 1,
            kind: "search",
            projectIdentity: input.projectIdentity,
            rootSessionId: input.rootSessionId,
            outputRef,
            patternDigest: patternDigest(input.pattern),
            runnerCursor: result.nextCursor,
          });
      return {
        outputRef,
        matches: result.matches.map((match) => ({ ...match, outputRef })),
        nextCursor,
        searchCompleteness:
          entry.metadata.completeness === "complete" ? "complete" : "partial_artifact",
      };
    } catch (error) {
      if (error instanceof ToolOutputError) throw error;
      if (controller.signal.aborted || this.now() >= deadlineAt) {
        throw new ToolOutputError("TOOL_OUTPUT_SEARCH_TIMEOUT");
      }
      throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      this.release(outputRef);
    }
  }

  private async searchFamily(input: OutputSearchInput): Promise<OutputSearchPage> {
    await this.assertReady();
    assertScope(input);
    assertPattern(input.pattern);
    const requestedLimit = input.limit ?? TOOL_OUTPUT_SEARCH_DEFAULT_MATCHES;
    if (
      !Number.isSafeInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > TOOL_OUTPUT_SEARCH_MAX_MATCHES
    ) {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }
    const maxContentBytes = input.maxContentBytes ?? TOOL_OUTPUT_SEARCH_MAX_BYTES;
    if (
      !Number.isSafeInteger(maxContentBytes) ||
      maxContentBytes < TOOL_OUTPUT_SEARCH_SNIPPET_MAX_BYTES ||
      maxContentBytes > TOOL_OUTPUT_SEARCH_MAX_BYTES
    ) {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }
    const digest = patternDigest(input.pattern);
    let lease: FamilySearchLease;
    let artifactIndex = 0;
    let artifactCursor: string | undefined;

    if (input.cursor === undefined) {
      lease = await this.createFamilyLease(input, digest);
    } else {
      const payload = this.cursor().decode(input.cursor);
      if (
        !isFamilySearchCursor(payload) ||
        payload.projectIdentity !== input.projectIdentity ||
        payload.rootSessionId !== input.rootSessionId ||
        payload.patternDigest !== digest
      ) {
        throw new ToolOutputError("TOOL_OUTPUT_INVALID_CURSOR");
      }
      const found = this.leases.get(payload.leaseId);
      if (
        !found ||
        found.expiresAt <= this.now() ||
        found.projectIdentity !== input.projectIdentity ||
        found.rootSessionId !== input.rootSessionId ||
        found.patternDigest !== digest ||
        payload.artifactIndex > found.refs.length
      ) {
        if (found) this.releaseLease(found.id);
        throw new ToolOutputError("TOOL_OUTPUT_INVALID_CURSOR");
      }
      lease = found;
      artifactIndex = payload.artifactIndex;
      artifactCursor = payload.artifactCursor;
    }

    if (artifactIndex >= lease.refs.length) {
      this.releaseLease(lease.id);
      return { matches: [], searchCompleteness: "complete" };
    }

    const deadlineAt = this.now() + TOOL_OUTPUT_SEARCH_TIMEOUT_MS;
    const matches: OutputSearchPage["matches"][number][] = [];
    let contentBytes = 0;
    let completeness: OutputSearchPage["searchCompleteness"] = "complete";
    let nextIndex = artifactIndex;
    let nextArtifactCursor = artifactCursor;
    while (
      nextIndex < lease.refs.length &&
      matches.length < requestedLimit &&
      maxContentBytes - contentBytes >= TOOL_OUTPUT_SEARCH_SNIPPET_MAX_BYTES
    ) {
      const outputRef = lease.refs[nextIndex]!;
      let page: OutputSearchPage;
      try {
        page = await this.searchSingle(
          {
            ...input,
            outputRef,
            cursor: nextArtifactCursor,
            limit: requestedLimit - matches.length,
          },
          {
            deadlineAt,
            maxContentBytes: maxContentBytes - contentBytes,
          },
        );
      } catch (error) {
        if (
          error instanceof ToolOutputError &&
          (error.code === "TOOL_OUTPUT_EXPIRED" ||
            error.code === "TOOL_OUTPUT_EVICTED" ||
            error.code === "TOOL_OUTPUT_NOT_FOUND")
        ) {
          page = { outputRef, matches: [], searchCompleteness: "complete" };
        } else {
          throw error;
        }
      }
      matches.push(...page.matches);
      for (const match of page.matches) contentBytes += utf8ByteLength(match.snippet);
      if (page.searchCompleteness === "partial_artifact") completeness = "partial_artifact";
      if (page.nextCursor !== undefined) {
        nextArtifactCursor = page.nextCursor;
        break;
      }
      nextIndex += 1;
      nextArtifactCursor = undefined;
    }

    if (!this.leases.has(lease.id) || lease.expiresAt <= this.now()) {
      this.releaseLease(lease.id);
      throw new ToolOutputError("TOOL_OUTPUT_INVALID_CURSOR");
    }

    let nextCursor: string | undefined;
    if (nextIndex < lease.refs.length) {
      nextCursor = this.cursor().encode({
        v: 1,
        kind: "family-search",
        projectIdentity: input.projectIdentity,
        rootSessionId: input.rootSessionId,
        patternDigest: digest,
        leaseId: lease.id,
        artifactIndex: nextIndex,
        ...(nextArtifactCursor === undefined ? {} : { artifactCursor: nextArtifactCursor }),
      });
    } else {
      this.releaseLease(lease.id);
    }
    return {
      matches,
      nextCursor,
      searchCompleteness: completeness,
    };
  }

  async deleteProducerSessions(
    scope: ArtifactAuthorizationScope,
    producerSessionIds: ReadonlySet<string>,
  ): Promise<number> {
    await this.assertReady();
    assertScope(scope);
    return this.mutex.withLock(async () => {
      let removed = 0;
      for (const [ref, entry] of this.artifacts) {
        if (
          ownersMatch(entry.metadata.owner, scope) &&
          producerSessionIds.has(entry.metadata.owner.producerSessionId)
        ) {
          await this.removeArtifactLocked(ref, undefined);
          removed += 1;
        }
      }
      return removed;
    });
  }

  async deleteRootFamily(scope: ArtifactAuthorizationScope): Promise<number> {
    await this.assertReady();
    assertScope(scope);
    return this.mutex.withLock(async () => {
      let removed = 0;
      for (const [ref, entry] of this.artifacts) {
        if (ownersMatch(entry.metadata.owner, scope)) {
          await this.removeArtifactLocked(ref, undefined);
          removed += 1;
        }
      }
      for (const [ref, entry] of this.tombstones) {
        if (ownersMatch(entry.tombstone.owner, scope)) {
          await rm(this.tombstonePath(ref), { force: true });
          this.tombstones.delete(ref);
        }
      }
      return removed;
    });
  }

  async countRecoverable(scope: ArtifactAuthorizationScope): Promise<number> {
    await this.assertReady();
    assertScope(scope);
    return this.mutex.withLock(async () => {
      await this.cleanupLocked();
      let count = 0;
      for (const entry of this.artifacts.values()) {
        if (ownersMatch(entry.metadata.owner, scope)) count += 1;
      }
      return count;
    });
  }

  async cleanup(): Promise<void> {
    await this.assertReady();
    await this.mutex.withLock(async () => {
      await this.cleanupLocked();
      await this.enforceQuotaLocked(new Set());
    });
  }

  async stats(): Promise<{
    active: number;
    tombstones: number;
    bodyBytes: number;
    ledgerBytes: number;
    totalBytes: number;
    leases: number;
    pinnedRefs: number;
  }> {
    await this.assertReady();
    return this.mutex.withLock(async () => ({
      active: this.artifacts.size,
      tombstones: this.tombstones.size,
      bodyBytes: this.totalBodyBytes(),
      ledgerBytes: this.totalLedgerBytes(),
      totalBytes: this.totalBodyBytes() + this.totalLedgerBytes(),
      leases: this.leases.size,
      pinnedRefs: this.pinnedRefs.size,
    }));
  }

  async dispose(): Promise<void> {
    await this.initialization.catch(() => undefined);
    await Promise.all([...this.activeCaptures.values()].map((capture) => capture.abort()));
    this.activeCaptures.clear();
    this.disposed = true;
    if (this.cleanupTimer !== undefined) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    for (const leaseId of [...this.leases.keys()]) this.releaseLease(leaseId);
  }

  private async initialize(cursorKey: Uint8Array | undefined): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await mkdir(this.artifactsDir, { recursive: true });
    await mkdir(this.tombstonesDir, { recursive: true });
    this.cursorCodec = new OpaqueCursorCodec(cursorKey ?? (await this.loadOrCreateCursorKey()));
    await this.loadArtifacts();
    await this.loadTombstones();
    await this.mutex.withLock(async () => {
      await this.cleanupStaleTempsLocked();
      await this.cleanupLocked();
      await this.enforceQuotaLocked(new Set());
    });
    if (this.limits.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        void this.cleanup().catch(() => undefined);
      }, this.limits.cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }
  }

  private async assertReady(): Promise<void> {
    await this.initialization;
    if (this.disposed) throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
  }

  private async commitCapturedArtifact(
    draft: CapturedArtifactDraft,
    generationIsActive: () => boolean,
  ): Promise<CreatedArtifact> {
    await this.assertReady();
    return this.mutex.withLock(async () => {
      if (!generationIsActive()) {
        await rm(draft.tempDir, { recursive: true, force: true });
        throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
      }
      const outputRef = await this.allocateOutputRef();
      const createdAt = this.now();
      const metadata: ArtifactMetadata = {
        version: 1,
        outputRef,
        owner: draft.owner,
        createdAt,
        expiresAt: createdAt + this.limits.bodyTtlMs,
        lastAccessedAt: createdAt,
        completeness: draft.omitted.bytes === 0 ? "complete" : "partial",
        observed: draft.observed,
        canonical: draft.canonical,
        stored: draft.stored,
        omitted: draft.omitted,
        segments: draft.segments,
      };
      const serialized = JSON.stringify(metadata);
      if (utf8ByteLength(serialized) > TOOL_OUTPUT_METADATA_MAX_BYTES) {
        await rm(draft.tempDir, { recursive: true, force: true });
        throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
      }
      await this.cleanupLocked();
      this.assertLedgerAdmission(utf8ByteLength(serialized), 1);
      await writeFile(join(draft.tempDir, METADATA_FILE), serialized);
      if (!generationIsActive()) {
        await rm(draft.tempDir, { recursive: true, force: true });
        throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
      }
      const finalDir = this.artifactPath(outputRef);
      await rename(draft.tempDir, finalDir);
      this.artifacts.set(outputRef, {
        metadata,
        bodyBytes: metadata.stored.bytes,
        ledgerBytes: utf8ByteLength(serialized),
      });
      await this.enforceQuotaLocked(new Set([outputRef]));
      if (
        !generationIsActive() ||
        this.artifacts.size > this.limits.bodyMaxActive ||
        this.totalBodyBytes() > this.limits.bodyQuotaBytes
      ) {
        await this.removeArtifactLocked(outputRef, generationIsActive() ? "evicted" : undefined);
        throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
      }
      return { outputRef, metadata: publicMetadata(metadata), projection: draft.projection };
    });
  }

  private cursor(): OpaqueCursorCodec {
    if (!this.cursorCodec) throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
    return this.cursorCodec;
  }

  private async readWindow(
    handle: ArtifactReadHandle,
    position: number,
    length: number,
  ): Promise<Uint8Array> {
    const buffer = new Uint8Array(length);
    let total = 0;
    while (total < length) {
      const requested = length - total;
      const result = await handle.read(buffer, total, requested, position + total);
      if (
        !Number.isSafeInteger(result.bytesRead) ||
        result.bytesRead < 0 ||
        result.bytesRead > requested
      ) {
        throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
      }
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    return total === length ? buffer : buffer.subarray(0, total);
  }

  private async loadOrCreateCursorKey(): Promise<Uint8Array> {
    const path = join(this.rootDir, CURSOR_KEY_FILE);
    try {
      const existing = new Uint8Array(await readFile(path));
      if (existing.byteLength !== 32) throw new Error("invalid key");
      return existing;
    } catch (error) {
      if (isPlainObject(error) && error.code !== "ENOENT") {
        throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
      }
      const key = randomBytes(32);
      await writeAtomic(path, key);
      await chmod(path, 0o600);
      return key;
    }
  }

  private async loadArtifacts(): Promise<void> {
    for (const directory of await readdir(this.artifactsDir, { withFileTypes: true })) {
      const path = join(this.artifactsDir, directory.name);
      if (!directory.isDirectory() || !isOutputRef(directory.name)) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      try {
        const parsed = parseMetadata(await readBoundedJson(join(path, METADATA_FILE)));
        if (!parsed || parsed.outputRef !== directory.name) throw new Error("invalid metadata");
        const ledgerBytes = await fileSize(join(path, METADATA_FILE));
        let bodyBytes = 0;
        for (const segment of parsed.segments) {
          const size = await fileSize(join(path, segment.fileName));
          if (size !== segment.bytes) throw new Error("invalid body size");
          bodyBytes += size;
        }
        this.artifacts.set(parsed.outputRef, { metadata: parsed, bodyBytes, ledgerBytes });
      } catch {
        await rm(path, { recursive: true, force: true });
      }
    }
  }

  private async loadTombstones(): Promise<void> {
    for (const file of await readdir(this.tombstonesDir, { withFileTypes: true })) {
      const match = /^([A-Za-z0-9_-]{22})\.json$/.exec(file.name);
      const path = join(this.tombstonesDir, file.name);
      if (!file.isFile() || !match || !isOutputRef(match[1])) {
        await rm(path, { force: true });
        continue;
      }
      try {
        const parsed = parseTombstone(await readBoundedJson(path));
        if (!parsed || parsed.outputRef !== match[1]) throw new Error("invalid tombstone");
        this.tombstones.set(parsed.outputRef, {
          tombstone: parsed,
          ledgerBytes: await fileSize(path),
        });
      } catch {
        await rm(path, { force: true });
      }
    }
  }

  private selectSegments(bytes: Uint8Array): Array<{
    kind: ArtifactSegmentKind;
    fileName: "body.txt" | "head.txt" | "tail.txt";
    start: number;
    bytes: Uint8Array;
  }> {
    if (bytes.byteLength <= this.limits.artifactMaxBytes) {
      return [{ kind: "full", fileName: "body.txt", start: 0, bytes }];
    }
    const headEnd = safeUtf8End(bytes, this.limits.artifactHeadMaxBytes);
    const tailStart = Math.max(
      headEnd,
      safeUtf8Start(bytes, bytes.byteLength - this.limits.artifactTailMaxBytes),
    );
    return [
      { kind: "head", fileName: "head.txt", start: 0, bytes: bytes.subarray(0, headEnd) },
      { kind: "tail", fileName: "tail.txt", start: tailStart, bytes: bytes.subarray(tailStart) },
    ];
  }

  private async allocateOutputRef(): Promise<OutputRef> {
    for (let attempts = 0; attempts < 8; attempts += 1) {
      const ref = createOutputRef();
      if (
        !this.artifacts.has(ref) &&
        !this.tombstones.has(ref) &&
        !(await Bun.file(this.artifactPath(ref)).exists())
      ) {
        return ref;
      }
    }
    throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
  }

  private requireRef(value: string): OutputRef {
    if (!isOutputRef(value)) throw new ToolOutputError("TOOL_OUTPUT_NOT_FOUND");
    return value;
  }

  private cursorScopeMatches(
    cursor: ReadCursorPayload | SearchCursorPayload,
    scope: ArtifactAuthorizationScope,
    ref: OutputRef,
  ): boolean {
    return (
      cursor.projectIdentity === scope.projectIdentity &&
      cursor.rootSessionId === scope.rootSessionId &&
      cursor.outputRef === ref
    );
  }

  private async acquire(
    outputRef: OutputRef,
    scope: ArtifactAuthorizationScope,
  ): Promise<IndexedArtifact> {
    return this.mutex.withLock(async () => {
      let entry = this.artifacts.get(outputRef);
      if (!entry) {
        const tombstone = this.tombstones.get(outputRef)?.tombstone;
        if (!tombstone) throw new ToolOutputError("TOOL_OUTPUT_NOT_FOUND");
        if (!ownersMatch(tombstone.owner, scope)) {
          throw new ToolOutputError("TOOL_OUTPUT_FORBIDDEN");
        }
        throw new ToolOutputError(
          tombstone.reason === "expired" ? "TOOL_OUTPUT_EXPIRED" : "TOOL_OUTPUT_EVICTED",
        );
      }
      if (!ownersMatch(entry.metadata.owner, scope)) {
        throw new ToolOutputError("TOOL_OUTPUT_FORBIDDEN");
      }
      if (entry.metadata.expiresAt <= this.now()) {
        await this.removeArtifactLocked(outputRef, "expired");
        throw new ToolOutputError("TOOL_OUTPUT_EXPIRED");
      }
      const updated: ArtifactMetadata = { ...entry.metadata, lastAccessedAt: this.now() };
      const serialized = JSON.stringify(updated);
      if (
        this.totalLedgerBytes() - entry.ledgerBytes + utf8ByteLength(serialized) >
        this.limits.ledgerMaxBytes
      ) {
        throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
      }
      await writeAtomic(join(this.artifactPath(outputRef), METADATA_FILE), serialized);
      entry = {
        metadata: updated,
        bodyBytes: entry.bodyBytes,
        ledgerBytes: utf8ByteLength(serialized),
      };
      this.artifacts.set(outputRef, entry);
      this.inUse.set(outputRef, (this.inUse.get(outputRef) ?? 0) + 1);
      return entry;
    });
  }

  private release(outputRef: OutputRef): void {
    const count = this.inUse.get(outputRef) ?? 0;
    if (count <= 1) this.inUse.delete(outputRef);
    else this.inUse.set(outputRef, count - 1);
  }

  private async assertStillActive(
    outputRef: OutputRef,
    scope: ArtifactAuthorizationScope,
  ): Promise<void> {
    await this.mutex.withLock(async () => {
      const entry = this.artifacts.get(outputRef);
      if (entry) {
        if (!ownersMatch(entry.metadata.owner, scope)) {
          throw new ToolOutputError("TOOL_OUTPUT_FORBIDDEN");
        }
        if (entry.metadata.expiresAt <= this.now()) {
          await this.removeArtifactLocked(outputRef, "expired");
          throw new ToolOutputError("TOOL_OUTPUT_EXPIRED");
        }
        return;
      }
      const tombstone = this.tombstones.get(outputRef)?.tombstone;
      if (!tombstone) throw new ToolOutputError("TOOL_OUTPUT_NOT_FOUND");
      if (!ownersMatch(tombstone.owner, scope)) {
        throw new ToolOutputError("TOOL_OUTPUT_FORBIDDEN");
      }
      throw new ToolOutputError(
        tombstone.reason === "expired" ? "TOOL_OUTPUT_EXPIRED" : "TOOL_OUTPUT_EVICTED",
      );
    });
  }

  private validateSearchResult(
    metadata: ArtifactMetadata,
    matches: readonly ArtifactSearchRunnerMatch[],
    limit: number,
    maxContentBytes: number,
  ): void {
    if (!Array.isArray(matches) || matches.length > limit) {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }
    let contentBytes = 0;
    for (const match of matches) {
      const segment = metadata.segments.find((item) => item.kind === match.segment);
      const snippetBytes = utf8ByteLength(match.snippet);
      contentBytes += snippetBytes;
      if (
        !segment ||
        !Number.isSafeInteger(match.canonicalStart) ||
        !Number.isSafeInteger(match.canonicalEnd) ||
        match.canonicalStart < segment.canonicalStart ||
        match.canonicalEnd < match.canonicalStart ||
        match.canonicalEnd > segment.canonicalEnd ||
        snippetBytes > TOOL_OUTPUT_SEARCH_SNIPPET_MAX_BYTES ||
        contentBytes > maxContentBytes
      ) {
        throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
      }
    }
  }

  private async createFamilyLease(
    scope: ArtifactAuthorizationScope,
    digest: string,
  ): Promise<FamilySearchLease> {
    return this.mutex.withLock(async () => {
      await this.cleanupLocked();
      const refs = [...this.artifacts.entries()]
        .filter(([, entry]) => ownersMatch(entry.metadata.owner, scope))
        .sort((left, right) => {
          const created = left[1].metadata.createdAt - right[1].metadata.createdAt;
          return created !== 0 ? created : left[0].localeCompare(right[0]);
        })
        .map(([ref]) => ref);
      if (refs.length > this.limits.familyLeaseMaxRefs) {
        throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
      }

      while (
        this.leases.size >= this.limits.familyLeaseMaxGlobal ||
        this.familyLeaseCount(scope) >= this.limits.familyLeaseMaxPerFamily ||
        this.pinnedSlotCount() + refs.length > this.limits.familyLeaseMaxPinnedRefs
      ) {
        const oldest = this.familyLeaseCount(scope) >= this.limits.familyLeaseMaxPerFamily
          ? this.oldestLease(scope)
          : this.oldestLease();
        if (!oldest) throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
        this.releaseLease(oldest.id);
      }

      const id = createOutputRef();
      const createdAt = this.now();
      const lease: FamilySearchLease = {
        id,
        projectIdentity: scope.projectIdentity,
        rootSessionId: scope.rootSessionId,
        patternDigest: digest,
        refs,
        createdAt,
        expiresAt: createdAt + this.limits.familyLeaseTtlMs,
      };
      this.leases.set(id, lease);
      for (const ref of refs) this.pinnedRefs.set(ref, (this.pinnedRefs.get(ref) ?? 0) + 1);
      return lease;
    });
  }

  private familyLeaseCount(scope: ArtifactAuthorizationScope): number {
    let count = 0;
    for (const lease of this.leases.values()) {
      if (
        lease.projectIdentity === scope.projectIdentity &&
        lease.rootSessionId === scope.rootSessionId
      ) {
        count += 1;
      }
    }
    return count;
  }

  private pinnedSlotCount(): number {
    let count = 0;
    for (const lease of this.leases.values()) count += lease.refs.length;
    return count;
  }

  private oldestLease(scope?: ArtifactAuthorizationScope): FamilySearchLease | undefined {
    return [...this.leases.values()].filter((lease) =>
      scope === undefined ||
      (lease.projectIdentity === scope.projectIdentity && lease.rootSessionId === scope.rootSessionId)
    ).sort((left, right) => {
      const created = left.createdAt - right.createdAt;
      return created !== 0 ? created : left.id.localeCompare(right.id);
    })[0];
  }

  private releaseLease(leaseId: string): void {
    const lease = this.leases.get(leaseId);
    if (!lease) return;
    this.leases.delete(leaseId);
    for (const ref of lease.refs) {
      const count = this.pinnedRefs.get(ref) ?? 0;
      if (count <= 1) this.pinnedRefs.delete(ref);
      else this.pinnedRefs.set(ref, count - 1);
    }
  }

  private assertLedgerAdmission(additionalBytes: number, additionalEntries: number): void {
    if (
      this.artifacts.size + this.tombstones.size + additionalEntries >
        this.limits.ledgerMaxEntries ||
      this.totalLedgerBytes() + additionalBytes > this.limits.ledgerMaxBytes
    ) {
      throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
    }
  }

  private async cleanupLocked(): Promise<void> {
    const now = this.now();
    for (const [ref, entry] of this.artifacts) {
      if (entry.metadata.expiresAt <= now) {
        await this.removeArtifactLocked(ref, "expired");
      }
    }
    for (const [ref, entry] of this.tombstones) {
      if (entry.tombstone.expiresAt <= now) {
        await rm(this.tombstonePath(ref), { force: true });
        this.tombstones.delete(ref);
      }
    }
    for (const lease of [...this.leases.values()]) {
      if (lease.expiresAt <= now) this.releaseLease(lease.id);
    }
  }

  private async cleanupStaleTempsLocked(): Promise<void> {
    const now = this.now();
    const roots = [this.rootDir, this.artifactsDir, this.tombstonesDir];
    for (const artifact of this.artifacts.keys()) roots.push(this.artifactPath(artifact));
    for (const directory of roots) {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.name.includes(TEMP_PREFIX)) continue;
        const path = join(directory, entry.name);
        if (this.activeCaptures.has(path)) continue;
        try {
          const info = await stat(path);
          if (now - info.mtimeMs >= this.limits.staleTempMs) {
            await rm(path, { recursive: true, force: true });
          }
        } catch {
          // Concurrent cleanup is harmless.
        }
      }
    }
  }

  private async enforceQuotaLocked(protectedRefs: ReadonlySet<OutputRef>): Promise<void> {
    while (
      this.artifacts.size > this.limits.bodyMaxActive ||
      this.totalBodyBytes() > this.limits.bodyQuotaBytes
    ) {
      const oldestLease = this.oldestLease();
      if (oldestLease) this.releaseLease(oldestLease.id);
      const candidate = [...this.artifacts.entries()]
        .filter(
          ([ref]) =>
            !protectedRefs.has(ref) &&
            !this.inUse.has(ref) &&
            !this.pinnedRefs.has(ref),
        )
        .sort((left, right) => {
          const access = left[1].metadata.lastAccessedAt - right[1].metadata.lastAccessedAt;
          if (access !== 0) return access;
          const created = left[1].metadata.createdAt - right[1].metadata.createdAt;
          return created !== 0 ? created : left[0].localeCompare(right[0]);
        })[0];
      if (!candidate) {
        if (oldestLease) continue;
        break;
      }
      await this.removeArtifactLocked(candidate[0], "evicted");
    }
  }

  private async removeArtifactLocked(
    outputRef: OutputRef,
    reason: ArtifactTombstoneReason | undefined,
  ): Promise<void> {
    const entry = this.artifacts.get(outputRef);
    if (!entry) return;
    await rm(this.artifactPath(outputRef), { recursive: true, force: true });
    this.artifacts.delete(outputRef);
    if (reason === undefined) return;
    const deletedAt = this.now();
    const tombstone: ArtifactTombstone = {
      version: 1,
      outputRef,
      owner: entry.metadata.owner,
      deletedAt,
      expiresAt: deletedAt + this.limits.tombstoneTtlMs,
      reason,
    };
    const serialized = JSON.stringify(tombstone);
    await writeAtomic(this.tombstonePath(outputRef), serialized);
    this.tombstones.set(outputRef, {
      tombstone,
      ledgerBytes: utf8ByteLength(serialized),
    });
  }

  private totalBodyBytes(): number {
    let total = 0;
    for (const entry of this.artifacts.values()) total += entry.bodyBytes;
    return total;
  }

  private totalLedgerBytes(): number {
    let total = 0;
    for (const entry of this.artifacts.values()) total += entry.ledgerBytes;
    for (const entry of this.tombstones.values()) total += entry.ledgerBytes;
    return total;
  }

  private artifactPath(outputRef: OutputRef): string {
    return join(this.artifactsDir, outputRef);
  }

  private tombstonePath(outputRef: OutputRef): string {
    return join(this.tombstonesDir, `${outputRef}.json`);
  }
}
