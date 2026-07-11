import { appendFile, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { normalizeUsage, PROJECT_STATE_DIR_NAME } from "@archcode/protocol";

import type { ModelPricing } from "../config/provider";
import type { ModelInfo } from "../provider/model";
import type { ToolExecutionControl } from "../tools/types";
import type {
  LoopBudgetConfig,
  LoopBudgetSnapshot,
  LoopBudgetUsage,
  LoopRunReason,
  LoopRunReport,
  LoopRunTrigger,
  LoopState,
} from "./state";
import { LoopBudgetConfigSchema, LoopBudgetSnapshotSchema, LoopBudgetUsageSchema, LoopConfigSchema, LoopRunReasonSchema, LoopStateManager } from "./state";

export interface LoopBudgetClock {
  now(): number;
}

export interface LoopBudgetLedgerOptions {
  readonly stateManager: LoopStateManager;
  readonly workspaceRoot: string;
  readonly clock?: LoopBudgetClock;
}

export interface LoopBudgetEvent {
  readonly event:
    | "run_started"
    | "model_usage"
    | "soft_budget_blocked"
    | "hard_budget_exceeded"
    | "daily_run_blocked";
  readonly loopId: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly source: string;
  readonly reason?: LoopRunReason;
  readonly usage: LoopBudgetUsage;
  readonly budget?: LoopBudgetConfig;
  readonly createdAt: number;
}

const LoopBudgetEventSchema = z.strictObject({
  event: z.enum(["run_started", "model_usage", "soft_budget_blocked", "hard_budget_exceeded", "daily_run_blocked"]),
  loopId: z.string().uuid(),
  runId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  source: z.string().trim().min(1),
  reason: LoopRunReasonSchema.optional(),
  usage: LoopBudgetUsageSchema,
  budget: LoopBudgetConfigSchema.optional(),
  createdAt: z.number().int().nonnegative(),
});

const LoopBudgetEventEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  event: LoopBudgetEventSchema,
});

export interface LoopBudgetStatus {
  readonly level: "ok" | "soft" | "hard";
  readonly reason?: LoopRunReason;
  readonly dimension?: "iterations" | "tokens" | "usd" | "wall_clock" | "runs_per_day";
}

export const LOOP_BUDGET_EXECUTION_CONTROL = {
  action: "stop_session_family",
  reason: "loop_budget_exceeded",
} as const satisfies ToolExecutionControl;

export class LoopBudgetHardStopError extends DOMException {
  readonly executionControl = LOOP_BUDGET_EXECUTION_CONTROL;

  constructor(public readonly loopId: string, message: string) {
    super(message, "AbortError");
  }
}

const systemClock: LoopBudgetClock = {
  now: () => Date.now(),
};

export class LoopBudgetLedger {
  readonly #stateManager: LoopStateManager;
  readonly #workspaceRoot: string;
  readonly #clock: LoopBudgetClock;

  constructor(options: LoopBudgetLedgerOptions) {
    this.#stateManager = options.stateManager;
    this.#workspaceRoot = options.workspaceRoot;
    this.#clock = options.clock ?? systemClock;
  }

  get clock(): LoopBudgetClock {
    return this.#clock;
  }

  async assertCanStartRun(
    loop: LoopState,
    runId: string,
    trigger: LoopRunTrigger,
    options: { readonly recordReport?: boolean } = {},
  ): Promise<LoopRunReport | undefined> {
    const current = await this.#stateManager.read(loop.loopId);
    const budget = effectiveBudget(current);
    const dateKey = utcDateKey(this.#clock.now());
    const previousRunsToday = sameUtcDate(current.latestBudget?.usage, dateKey)
      ? current.latestBudget?.usage.runsToday ?? 0
      : 0;

    if (budget.maxRunsPerDay !== undefined && previousRunsToday >= budget.maxRunsPerDay * budget.hardThresholdRatio) {
      const usage = emptyUsage(dateKey, previousRunsToday);
      const report = this.#budgetExceededReport(current, runId, trigger, usage, "hard_budget_exceeded", "Daily Loop run budget exceeded before run start.");
      await this.#persistSnapshot(current.loopId, budget, usage);
      await this.#recordEvent({ event: "daily_run_blocked", loopId: current.loopId, runId, source: "before_run", reason: "hard_budget_exceeded", usage, budget });
      await this.#stateManager.pause(current.loopId);
      if (options.recordReport !== false) await this.#stateManager.recordRunFinish(current.loopId, report);
      return report;
    }

    return undefined;
  }

  async recordRunStart(loopId: string, runId: string): Promise<LoopBudgetUsage> {
    const loop = await this.#stateManager.read(loopId);
    const budget = effectiveBudget(loop);
    const dateKey = utcDateKey(this.#clock.now());
    const previousRunsToday = sameUtcDate(loop.latestBudget?.usage, dateKey)
      ? loop.latestBudget?.usage.runsToday ?? 0
      : 0;
    const usage = emptyUsage(dateKey, previousRunsToday + 1);
    await this.#persistSnapshot(loopId, budget, usage);
    await this.#recordEvent({ event: "run_started", loopId, runId, source: "run_start", usage, budget });
    return usage;
  }

  async recordModelUsage(input: {
    readonly loopId: string;
    readonly runId?: string;
    readonly sessionId?: string;
    readonly rawUsage: unknown;
    readonly modelInfo?: ModelInfo;
    readonly source: string;
  }): Promise<{ usage: LoopBudgetUsage; status: LoopBudgetStatus; budget: LoopBudgetConfig }> {
    const loop = await this.#stateManager.read(input.loopId);
    const budget = effectiveBudget(loop);
    const usage = mergeModelUsage({
      previous: loop.latestBudget?.usage,
      rawUsage: input.rawUsage,
      pricing: input.modelInfo?.pricing,
      startedAt: loop.currentRun?.startedAt,
      now: this.#clock.now(),
    });
    const status = evaluateBudget(budget, usage);
    await this.#persistSnapshot(input.loopId, budget, usage);
    await this.#recordEvent({ event: "model_usage", loopId: input.loopId, runId: input.runId, sessionId: input.sessionId, source: input.source, reason: status.reason, usage, budget });
    return { usage, status, budget };
  }

  async refreshWallClock(loopId: string, source: string, runId?: string): Promise<{ usage: LoopBudgetUsage; status: LoopBudgetStatus; budget: LoopBudgetConfig }> {
    const loop = await this.#stateManager.read(loopId);
    const budget = effectiveBudget(loop);
    const usage = mergeModelUsage({
      previous: loop.latestBudget?.usage,
      rawUsage: undefined,
      pricing: undefined,
      startedAt: loop.currentRun?.startedAt,
      now: this.#clock.now(),
    });
    const status = evaluateBudget(budget, usage);
    await this.#persistSnapshot(loopId, budget, usage);
    await this.#recordEvent({ event: "model_usage", loopId, runId, source, reason: status.reason, usage, budget });
    return { usage, status, budget };
  }

  async recordSoftBlock(loopId: string, runId: string | undefined, sessionId: string | undefined, source: string): Promise<void> {
    const loop = await this.#stateManager.read(loopId);
    const budget = effectiveBudget(loop);
    const usage = loop.latestBudget?.usage ?? emptyUsage(utcDateKey(this.#clock.now()), 0);
    await this.#recordEvent({ event: "soft_budget_blocked", loopId, runId, sessionId, source, reason: "soft_budget_blocked", usage, budget });
  }

  async recordHardExceeded(input: {
    readonly loopId: string;
    readonly runId?: string;
    readonly sessionId?: string;
    readonly source: string;
    readonly summary?: string;
  }): Promise<LoopRunReport | undefined> {
    const loop = await this.#stateManager.read(input.loopId);
    const budget = effectiveBudget(loop);
    const usage = loop.latestBudget?.usage ?? emptyUsage(utcDateKey(this.#clock.now()), 0);
    await this.#persistSnapshot(input.loopId, budget, usage);
    await this.#recordEvent({ event: "hard_budget_exceeded", loopId: input.loopId, runId: input.runId, sessionId: input.sessionId, source: input.source, reason: "hard_budget_exceeded", usage, budget });
    await this.#stateManager.pause(input.loopId);

    if (input.runId === undefined) return undefined;
    const report = this.#budgetExceededReport(loop, input.runId, loop.currentRun?.trigger ?? "manual", usage, "hard_budget_exceeded", input.summary ?? "Loop hard budget exceeded.", input.sessionId);
    await this.#stateManager.recordRunFinish(input.loopId, report);
    return report;
  }

  evaluate(loop: LoopState): LoopBudgetStatus {
    return evaluateBudget(effectiveBudget(loop), loop.latestBudget?.usage ?? emptyUsage(utcDateKey(this.#clock.now()), 0));
  }

  #budgetExceededReport(
    loop: LoopState,
    runId: string,
    trigger: LoopRunTrigger,
    usage: LoopBudgetUsage,
    reason: LoopRunReason,
    summary: string,
    sessionId?: string,
  ): LoopRunReport {
    const startedAt = loop.currentRun?.runId === runId ? loop.currentRun.startedAt : this.#clock.now();
    return {
      runId,
      loopId: loop.loopId,
      status: "budget_exceeded",
      trigger,
      startedAt,
      endedAt: this.#clock.now(),
      reason,
      budgetUsage: usage,
      ...(sessionId === undefined ? {} : { sessionId }),
      summary,
    };
  }

  async #persistSnapshot(loopId: string, budget: LoopBudgetConfig, usage: LoopBudgetUsage): Promise<void> {
    const snapshot: LoopBudgetSnapshot = LoopBudgetSnapshotSchema.parse({ budget, usage, updatedAt: this.#clock.now() });
    await this.#stateManager.updateBudgetSnapshot(loopId, snapshot);
  }

  async #recordEvent(event: Omit<LoopBudgetEvent, "createdAt">): Promise<void> {
    const parsed = LoopBudgetEventSchema.parse({ ...event, createdAt: this.#clock.now() });
    const filePath = await resolveBudgetLedgerPath(this.#workspaceRoot, parsed.loopId);
    await mkdir(dirname(filePath), { recursive: true });
    const envelope = LoopBudgetEventEnvelopeSchema.parse({ version: 1, event: parsed });
    await appendFile(filePath, `${JSON.stringify(envelope)}\n`, "utf8");
  }
}

export function effectiveBudget(loop: LoopState): LoopBudgetConfig {
  const config = LoopConfigSchema.parse(loop.config);
  return LoopBudgetConfigSchema.parse(config.limits);
}

export function evaluateBudget(budget: LoopBudgetConfig, usage: LoopBudgetUsage): LoopBudgetStatus {
  const hard = thresholdExceeded(budget, usage, budget.hardThresholdRatio);
  if (hard !== undefined) return { level: "hard", reason: "hard_budget_exceeded", dimension: hard };
  const soft = thresholdExceeded(budget, usage, budget.softThresholdRatio);
  if (soft !== undefined) return { level: "soft", reason: "soft_budget_blocked", dimension: soft };
  return { level: "ok" };
}

function thresholdExceeded(
  budget: LoopBudgetConfig,
  usage: LoopBudgetUsage,
  ratio: number,
): LoopBudgetStatus["dimension"] | undefined {
  if (usage.iterations >= budget.maxIterationsPerRun * ratio) return "iterations";
  if (budget.maxTokensPerRun !== undefined && usage.totalTokens >= budget.maxTokensPerRun * ratio) return "tokens";
  if (
    budget.maxEstimatedUsdPerRun !== undefined &&
    usage.pricingUnavailable !== true &&
    usage.estimatedUsd !== undefined &&
    usage.estimatedUsd >= budget.maxEstimatedUsdPerRun * ratio
  ) return "usd";
  if (budget.maxWallClockMsPerRun !== undefined && usage.wallClockMs >= budget.maxWallClockMsPerRun * ratio) return "wall_clock";
  if (budget.maxRunsPerDay !== undefined && usage.runsToday > budget.maxRunsPerDay * ratio) return "runs_per_day";
  return undefined;
}

function mergeModelUsage(input: {
  readonly previous?: LoopBudgetUsage;
  readonly rawUsage: unknown;
  readonly pricing?: ModelPricing;
  readonly startedAt?: number;
  readonly now: number;
}): LoopBudgetUsage {
  const dateKey = utcDateKey(input.now);
  const previous = sameUtcDate(input.previous, dateKey) ? input.previous : undefined;
  const normalized = normalizeUsage(input.rawUsage);
  if (normalized.totalTokens === 0 && previous !== undefined) {
    return {
      ...previous,
      wallClockMs: input.startedAt === undefined ? previous.wallClockMs : Math.max(0, input.now - input.startedAt),
      resetDateUtc: dateKey,
    };
  }
  const usage: LoopBudgetUsage = {
    iterations: (previous?.iterations ?? 0) + (normalized.totalTokens > 0 ? 1 : 0),
    inputTokens: (previous?.inputTokens ?? 0) + normalized.inputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + normalized.outputTokens,
    reasoningTokens: (previous?.reasoningTokens ?? 0) + normalized.reasoningTokens,
    cachedInputTokens: (previous?.cachedInputTokens ?? 0) + normalized.cachedInputTokens,
    totalTokens: (previous?.totalTokens ?? 0) + normalized.totalTokens,
    wallClockMs: input.startedAt === undefined ? previous?.wallClockMs ?? 0 : Math.max(0, input.now - input.startedAt),
    runsToday: previous?.runsToday ?? 0,
    resetDateUtc: dateKey,
  };

  const estimatedUsd = estimateUsd(usage, input.pricing);
  if (estimatedUsd === undefined) return { ...usage, pricingUnavailable: true };
  return { ...usage, estimatedUsd, pricingUnavailable: false };
}

function estimateUsd(usage: LoopBudgetUsage, pricing: ModelPricing | undefined): number | undefined {
  if (pricing === undefined) return undefined;
  const inputRate = pricing.inputUsdPerMillionTokens;
  const outputRate = pricing.outputUsdPerMillionTokens;
  if (inputRate === undefined || outputRate === undefined) return undefined;

  const reasoningTokens = usage.reasoningTokens ?? 0;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  if (reasoningTokens > 0 && pricing.reasoningUsdPerMillionTokens === undefined) return undefined;
  if (cachedInputTokens > 0 && pricing.cachedInputUsdPerMillionTokens === undefined) return undefined;

  return usd(usage.inputTokens, inputRate) +
    usd(usage.outputTokens, outputRate) +
    usd(reasoningTokens, pricing.reasoningUsdPerMillionTokens ?? 0) +
    usd(cachedInputTokens, pricing.cachedInputUsdPerMillionTokens ?? 0);
}

function usd(tokens: number, usdPerMillionTokens: number): number {
  return (tokens / 1_000_000) * usdPerMillionTokens;
}

function emptyUsage(resetDateUtc: string, runsToday: number): LoopBudgetUsage {
  return {
    iterations: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    wallClockMs: 0,
    runsToday,
    resetDateUtc,
    pricingUnavailable: true,
  };
}

function sameUtcDate(usage: LoopBudgetUsage | undefined, dateKey: string): boolean {
  return usage?.resetDateUtc === dateKey;
}

export function utcDateKey(timestampMs: number): string {
  const d = new Date(timestampMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function resolveBudgetLedgerPath(workspaceRoot: string, loopId: string): Promise<string> {
  return await resolveContainedPath(join(loopId, "budget-ledger.jsonl"), resolve(workspaceRoot, PROJECT_STATE_DIR_NAME, "loops"));
}

class SafeLoopPathError extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(`Safe loop path error: ${reason} (path: "${path}")`);
    this.name = "SafeLoopPathError";
  }
}

async function resolveContainedPath(relative: string, root: string): Promise<string> {
  if (resolve(relative) === relative && !relative.startsWith(".")) {
    throw new SafeLoopPathError(relative, "Absolute paths are not allowed");
  }

  const normalized = resolve(root, relative);
  if (!isContained(normalized, root)) {
    throw new SafeLoopPathError(relative, "Path escapes the loops directory");
  }

  try {
    const realPath = await realpath(normalized);
    const realRoot = await realpath(root);
    if (!isContained(realPath, realRoot)) {
      throw new SafeLoopPathError(normalized, "Symlink resolves outside the loops directory");
    }
    return realPath;
  } catch (error) {
    if (error instanceof SafeLoopPathError) throw error;
    return normalized;
  }
}

function isContained(resolvedPath: string, root: string): boolean {
  const normalizedResolved = resolve(resolvedPath);
  const normalizedRoot = resolve(root);
  return normalizedResolved === normalizedRoot || normalizedResolved.startsWith(`${normalizedRoot}/`);
}
