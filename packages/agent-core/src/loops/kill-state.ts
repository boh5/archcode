import { existsSync } from "node:fs";
import { mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod/v4";

import type { Logger } from "../logger";
import { silentLogger } from "../logger";

const TimestampMsSchema = z.number().int().nonnegative();
const KillStateTextSchema = z.string().trim().min(1).max(20_000);

export interface LoopKillState {
  readonly globalKillActive: boolean;
  readonly activatedAt?: number;
  readonly activatedBy?: string;
  readonly reason?: string;
}

export interface LoopKillActivateInput {
  readonly activatedAt?: number;
  readonly activatedBy?: string;
  readonly reason?: string;
}

export const LoopKillStateSchema = z.strictObject({
  globalKillActive: z.boolean(),
  activatedAt: TimestampMsSchema.optional(),
  activatedBy: KillStateTextSchema.optional(),
  reason: KillStateTextSchema.optional(),
}) satisfies z.ZodType<LoopKillState>;

export class LoopKillStateError extends Error {
  constructor(public readonly cause: unknown) {
    super("Invalid Loop kill state");
    this.name = "LoopKillStateError";
  }
}

export class LoopKillStateManager {
  readonly #workspaceRoot: string;
  readonly #clock: { now(): number };
  readonly #logger: Logger;

  constructor(
    workspaceRoot: string,
    options: { readonly clock?: { now(): number }; readonly logger?: Logger } = {},
  ) {
    this.#workspaceRoot = workspaceRoot;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#logger = (options.logger ?? silentLogger).child({ module: "loops.kill-state" });
  }

  async read(): Promise<LoopKillState> {
    const filePath = await this.killStatePath();
    if (!existsSync(filePath)) return defaultKillState();

    const content = await Bun.file(filePath).text();
    return this.parse(content);
  }

  async activate(input: LoopKillActivateInput = {}): Promise<LoopKillState> {
    const state = LoopKillStateSchema.parse({
      globalKillActive: true,
      activatedAt: input.activatedAt ?? this.#clock.now(),
      ...(input.activatedBy === undefined ? {} : { activatedBy: input.activatedBy }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    await this.write(state);
    return state;
  }

  async clear(): Promise<LoopKillState> {
    const state = defaultKillState();
    await this.write(state);
    return state;
  }

  private async write(state: LoopKillState): Promise<void> {
    const parsed = LoopKillStateSchema.parse(state);
    await atomicWrite(await this.killStatePath(), `${JSON.stringify(parsed, null, 2)}\n`);
  }

  private parse(content: string): LoopKillState {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      this.#logger.warn("loops.kill-state.parse.failed", { error });
      throw new LoopKillStateError(error);
    }

    const result = LoopKillStateSchema.safeParse(parsed);
    if (!result.success) {
      this.#logger.warn("loops.kill-state.validation.failed", { error: result.error });
      throw new LoopKillStateError(result.error);
    }
    return result.data;
  }

  private async killStatePath(): Promise<string> {
    return await resolveContainedPath("kill-state.json", resolve(this.#workspaceRoot, ".archcode", "loops"));
  }
}

function defaultKillState(): LoopKillState {
  return { globalKillActive: false };
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `.tmp-${crypto.randomUUID()}`);
  try {
    await Bun.write(tmpPath, content);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }

  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

class SafeLoopKillPathError extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(`Safe Loop kill-state path error: ${reason} (path: "${path}")`);
    this.name = "SafeLoopKillPathError";
  }
}

async function resolveContainedPath(relative: string, root: string): Promise<string> {
  if (resolve(relative) === relative && !relative.startsWith(".")) {
    throw new SafeLoopKillPathError(relative, "Absolute paths are not allowed");
  }

  const normalized = resolve(root, relative);
  if (!isContained(normalized, root)) {
    throw new SafeLoopKillPathError(relative, "Path escapes the loops directory");
  }

  try {
    const realPath = await realpath(normalized);
    const realRoot = await realpath(root);
    if (!isContained(realPath, realRoot)) {
      throw new SafeLoopKillPathError(normalized, "Symlink resolves outside the loops directory");
    }
    return realPath;
  } catch (error) {
    if (error instanceof SafeLoopKillPathError) throw error;
    return normalized;
  }
}

function isContained(resolvedPath: string, root: string): boolean {
  const normalizedResolved = resolve(resolvedPath);
  const normalizedRoot = resolve(root);
  return normalizedResolved === normalizedRoot || normalizedResolved.startsWith(`${normalizedRoot}/`);
}
