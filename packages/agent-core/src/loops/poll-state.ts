import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod/v4";

import { atomicWrite, isContained } from "../utils/safe-file";
import { LoopRunTriggerSchema, LoopUuidSchema, type LoopRunTrigger } from "./state";

export interface LoopPollStateClock {
  now(): number;
}

export interface LoopPollCursorEntry {
  readonly cursorKey: string;
  readonly kind: LoopRunTrigger;
  readonly lastCheckedAt?: number;
  readonly lastSuccessAt?: number;
  readonly backoffUntilAt?: number;
  readonly lastError?: string;
  readonly localBranchHeads?: Record<string, string>;
  readonly pullRequests?: Record<string, LoopPollPullRequestCursor>;
  readonly ciFailures?: Record<string, LoopPollCiFailureCursor>;
}

export interface LoopPollPullRequestCursor {
  readonly number: number;
  readonly headSha: string;
  readonly updatedAt?: string;
  readonly observedAt: number;
}

export interface LoopPollCiFailureCursor {
  readonly subjectKey: string;
  readonly sha: string;
  readonly context: string;
  readonly observedAt: number;
}

export interface LoopPollStateFile {
  readonly version: 1;
  readonly loopId: string;
  readonly cursors: Record<string, LoopPollCursorEntry>;
  readonly updatedAt: number;
}

export interface LoopPollStateManagerOptions {
  readonly workspaceRoot: string;
  readonly clock?: LoopPollStateClock;
  readonly maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

const TimestampMsSchema = z.number().int().nonnegative();
const IdentifierSchema = z.string().trim().min(1).max(500);
const ShaSchema = z.string().trim().min(1).max(128);

export const LoopPollPullRequestCursorSchema = z.strictObject({
  number: z.number().int().positive(),
  headSha: ShaSchema,
  updatedAt: z.string().trim().min(1).max(200).optional(),
  observedAt: TimestampMsSchema,
}) satisfies z.ZodType<LoopPollPullRequestCursor>;

export const LoopPollCiFailureCursorSchema = z.strictObject({
  subjectKey: IdentifierSchema,
  sha: ShaSchema,
  context: IdentifierSchema,
  observedAt: TimestampMsSchema,
}) satisfies z.ZodType<LoopPollCiFailureCursor>;

export const LoopPollCursorEntrySchema = z.strictObject({
  cursorKey: IdentifierSchema,
  kind: LoopRunTriggerSchema,
  lastCheckedAt: TimestampMsSchema.optional(),
  lastSuccessAt: TimestampMsSchema.optional(),
  backoffUntilAt: TimestampMsSchema.optional(),
  lastError: z.string().trim().min(1).max(20_000).optional(),
  localBranchHeads: z.record(z.string(), ShaSchema).optional(),
  pullRequests: z.record(z.string(), LoopPollPullRequestCursorSchema).optional(),
  ciFailures: z.record(z.string(), LoopPollCiFailureCursorSchema).optional(),
}) satisfies z.ZodType<LoopPollCursorEntry>;

export const LoopPollStateFileSchema = z.strictObject({
  version: z.literal(1),
  loopId: LoopUuidSchema,
  cursors: z.record(z.string(), LoopPollCursorEntrySchema),
  updatedAt: TimestampMsSchema,
}) satisfies z.ZodType<LoopPollStateFile>;

const systemClock: LoopPollStateClock = {
  now: () => Date.now(),
};

export class LoopPollStateParseError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly cause: unknown,
  ) {
    super(`Invalid loop poll state file: ${filePath}`);
    this.name = "LoopPollStateParseError";
  }
}

export class LoopPollStateSecurityError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Loop poll state rejected ${field}: ${reason}`);
    this.name = "LoopPollStateSecurityError";
  }
}

export class LoopPollStateManager {
  readonly #workspaceRoot: string;
  readonly #clock: LoopPollStateClock;
  readonly #maxFileBytes: number;

  constructor(options: LoopPollStateManagerOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#clock = options.clock ?? systemClock;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  async read(loopId: string): Promise<LoopPollStateFile> {
    const parsedLoopId = LoopUuidSchema.parse(loopId);
    const filePath = await pollStatePath(this.#workspaceRoot, parsedLoopId);
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return { version: 1, loopId: parsedLoopId, cursors: {}, updatedAt: this.#clock.now() };
    }
    if (file.size > this.#maxFileBytes) throw new LoopPollStateSecurityError("maxFileBytes", `File exceeds ${this.#maxFileBytes} bytes`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      throw new LoopPollStateParseError(filePath, error);
    }

    const result = LoopPollStateFileSchema.safeParse(parsed);
    if (!result.success) throw new LoopPollStateParseError(filePath, result.error);
    if (result.data.loopId !== parsedLoopId) throw new LoopPollStateParseError(filePath, `Poll state belongs to ${result.data.loopId}`);
    return result.data;
  }

  async write(state: LoopPollStateFile): Promise<LoopPollStateFile> {
    const parsed = LoopPollStateFileSchema.parse({ ...state, updatedAt: state.updatedAt ?? this.#clock.now() });
    await atomicWrite(await pollStatePath(this.#workspaceRoot, parsed.loopId), `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  }

  async updateCursor(loopId: string, cursorKey: string, update: (current: LoopPollCursorEntry | undefined, now: number) => LoopPollCursorEntry): Promise<LoopPollCursorEntry> {
    const now = this.#clock.now();
    const state = await this.read(loopId);
    const nextCursor = LoopPollCursorEntrySchema.parse(update(state.cursors[cursorKey], now));
    await this.write({
      ...state,
      cursors: { ...state.cursors, [cursorKey]: nextCursor },
      updatedAt: now,
    });
    return nextCursor;
  }

  async statePath(loopId: string): Promise<string> {
    return await pollStatePath(this.#workspaceRoot, LoopUuidSchema.parse(loopId));
  }
}

async function pollStatePath(workspaceRoot: string, loopId: string): Promise<string> {
  const loopsRoot = resolve(workspaceRoot, ".archcode", "loops");
  await assertSafeLoopRoot(workspaceRoot, loopsRoot);
  await mkdir(resolve(loopsRoot, loopId), { recursive: true });
  const filePath = resolve(loopsRoot, loopId, "poll-state.json");
  if (!isContained(filePath, loopsRoot)) throw new LoopPollStateSecurityError("path", "Path escapes the loops directory");
  return filePath;
}

async function assertSafeLoopRoot(workspaceRoot: string, loopsRoot: string): Promise<void> {
  const realWorkspaceRoot = await realpath(workspaceRoot);
  await assertExistingPathContained(resolve(workspaceRoot, ".archcode"), realWorkspaceRoot);
  await assertExistingPathContained(loopsRoot, realWorkspaceRoot);
}

async function assertExistingPathContained(path: string, realWorkspaceRoot: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (!stat.isSymbolicLink()) return;
  const realPath = await realpath(path);
  if (!isContained(realPath, realWorkspaceRoot)) {
    throw new LoopPollStateSecurityError("path", "Symlink resolves outside the workspace");
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
