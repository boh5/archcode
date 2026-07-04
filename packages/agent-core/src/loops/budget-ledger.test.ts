import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { ModelInfo } from "../provider/model";
import { LoopBudgetLedger, evaluateBudget, utcDateKey } from "./budget-ledger";
import { LoopBudgetConfigSchema, LoopStateManager, type LoopBudgetConfig, type LoopConfig } from "./state";
import { FakeClock } from "./test-utils";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-budget-ledger");

const config: LoopConfig = {
  title: "Budgeted loop",
  schedule: { kind: "manual" },
  runKind: "session",
  mode: "act",
  approvalPolicy: "interactive",
  limits: {
    maxIterationsPerRun: 4,
    maxTokensPerRun: 1_000,
    maxEstimatedUsdPerRun: 1,
    maxWallClockMsPerRun: 60_000,
    maxRunsPerDay: 2,
    softThresholdRatio: 0.8,
    hardThresholdRatio: 1,
  },
};

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("LoopBudgetLedger", () => {
  test("persists per-run usage and marks missing pricing unavailable without zero-cost enforcement", async () => {
    const clock = new FakeClock(Date.UTC(2026, 6, 4, 10, 0, 0));
    const stateManager = new LoopStateManager(TMP_DIR);
    const loop = await stateManager.create("project-a", config);
    const ledger = new LoopBudgetLedger({ stateManager, workspaceRoot: TMP_DIR, clock });

    await stateManager.recordRunStart(loop.loopId, {
      runId: "run-1",
      loopId: loop.loopId,
      status: "running",
      trigger: "manual",
      startedAt: clock.now(),
    });
    await ledger.recordRunStart(loop.loopId, "run-1");
    const result = await ledger.recordModelUsage({
      loopId: loop.loopId,
      runId: "run-1",
      sessionId: "session-1",
      rawUsage: { inputTokens: 600, outputTokens: 300, totalTokens: 900 },
      modelInfo: makeModelInfo(),
      source: "test",
    });

    expect(result.usage).toMatchObject({ totalTokens: 900, runsToday: 1, resetDateUtc: "2026-07-04", pricingUnavailable: true });
    expect(result.usage.estimatedUsd).toBeUndefined();
    expect(result.status).toMatchObject({ level: "soft", reason: "soft_budget_blocked", dimension: "tokens" });

    const persisted = await stateManager.read(loop.loopId);
    expect(persisted.latestBudget?.usage).toEqual(result.usage);
    const jsonl = await Bun.file(join(TMP_DIR, ".archcode", "loops", loop.loopId, "budget-ledger.jsonl")).text();
    expect(jsonl).toContain("model_usage");
  });

  test("uses UTC date keys and resets daily run accounting at UTC midnight", async () => {
    const clock = new FakeClock(Date.UTC(2026, 6, 4, 23, 59, 59, 999));
    const stateManager = new LoopStateManager(TMP_DIR);
    const loop = await stateManager.create("project-a", config);
    const ledger = new LoopBudgetLedger({ stateManager, workspaceRoot: TMP_DIR, clock });

    await ledger.recordRunStart(loop.loopId, "run-before-midnight");
    expect((await stateManager.read(loop.loopId)).latestBudget?.usage.runsToday).toBe(1);
    expect((await stateManager.read(loop.loopId)).latestBudget?.usage.resetDateUtc).toBe("2026-07-04");

    clock.set(Date.UTC(2026, 6, 5, 0, 0, 0, 0));
    await ledger.recordRunStart(loop.loopId, "run-after-midnight");

    const usage = (await stateManager.read(loop.loopId)).latestBudget?.usage;
    expect(usage?.runsToday).toBe(1);
    expect(usage?.resetDateUtc).toBe("2026-07-05");
    expect(utcDateKey(clock.now())).toBe("2026-07-05");
  });

  test("blocks pre-run when max daily runs hard threshold is exceeded", async () => {
    const clock = new FakeClock(Date.UTC(2026, 6, 4, 12, 0, 0));
    const stateManager = new LoopStateManager(TMP_DIR);
    const loop = await stateManager.create("project-a", { ...config, limits: { ...config.limits, maxRunsPerDay: 1 } });
    const ledger = new LoopBudgetLedger({ stateManager, workspaceRoot: TMP_DIR, clock });

    await ledger.recordRunStart(loop.loopId, "run-1");
    const report = await ledger.assertCanStartRun(await stateManager.read(loop.loopId), "run-2", "interval");

    expect(report).toMatchObject({ status: "budget_exceeded", reason: "hard_budget_exceeded" });
    expect((await stateManager.read(loop.loopId)).status).toBe("paused");
  });
});

test("evaluateBudget ignores USD thresholds when pricing is unavailable", () => {
  const status = evaluateBudget(normalizedBudget(), {
    iterations: 1,
    inputTokens: 10,
    outputTokens: 10,
    totalTokens: 20,
    estimatedUsd: undefined,
    wallClockMs: 1,
    runsToday: 1,
    resetDateUtc: "2026-07-04",
    pricingUnavailable: true,
  });

  expect(status.level).toBe("ok");
});

function normalizedBudget(): LoopBudgetConfig {
  return LoopBudgetConfigSchema.parse(config.limits);
}

function makeModelInfo(): ModelInfo {
  return new ModelInfo({
    model: {} as never,
    providerId: "test",
    modelId: "missing-pricing",
    config: {
      name: "Missing pricing",
      limit: { context: 100_000, output: 10_000 },
      modalities: { input: ["text"], output: ["text"] },
    },
  });
}
