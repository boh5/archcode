import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { ProjectContextResolver } from "../projects/context-resolver";
import { ModelInfo } from "../provider/model";
import { createSessionStore } from "../store/store";
import { SessionStoreManager } from "../store/session-store-manager";
import { silentLogger } from "../logger";
import { createTestProjectContextResolverOptions } from "../tools/test-project-context";
import { LoopBudgetHardStopError, LoopBudgetLedger } from "./budget-ledger";
import { enforceLoopBudgetAfterStepEnd } from "./budget-hooks";
import { LoopStateManager, type LoopConfig } from "./state";
import { FakeClock, FakeSessionExecutionManager } from "./test-utils";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-budget-hooks");

const config: LoopConfig = {
  templateId: "watch_report",
  title: "Hooked loop",
  schedule: { kind: "manual" },
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 8, maxTokensPerRun: 100, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
  useWorktree: false,
};

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("Loop budget query hooks", () => {
  test("afterStepEnd records usage and hard-stops with abort seam", async () => {
    const clock = new FakeClock(Date.UTC(2026, 6, 4, 12, 0, 0));
    const stateManager = new LoopStateManager(TMP_DIR);
    const loop = await stateManager.create("project-a", config);
    const ledger = new LoopBudgetLedger({ stateManager, workspaceRoot: TMP_DIR, clock });
    await stateManager.recordRunStart(loop.loopId, { runId: "run-1", loopId: loop.loopId, status: "running", trigger: "manual", startedAt: clock.now(), sessionId: "session-1" });
    await ledger.recordRunStart(loop.loopId, "run-1");

    const sessions = new SessionStoreManager({ logger: silentLogger });
    const resolver = new ProjectContextResolver({
      ...createTestProjectContextResolverOptions(sessions),
      projectInfoFactory: () => ({ slug: "project-a", name: "Project A", workspaceRoot: TMP_DIR, addedAt: "2026-07-04T00:00:00.000Z" }),
    });
    const projectContext = await resolver.resolve(TMP_DIR);
    const store = createSessionStore("session-1", TMP_DIR);
    store.setState({ loopId: loop.loopId });
    store.getState().append({ type: "step-start", step: 0 });
    store.getState().append({ type: "step-end", step: 0, finishReason: "stop", usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100 } });
    const executionManager = new FakeSessionExecutionManager();

    await expect(enforceLoopBudgetAfterStepEnd({
      store,
      modelInfo: makeModelInfo(),
      logger: { child: () => ({}) } as never,
      projectContext,
    }, {
      origin: { kind: "loop", loopId: loop.loopId, runId: "run-1", trigger: "manual", approvalPolicy: "interactive" },
      abortSessionExecutionAndWait: (workspaceRoot, sessionId) => executionManager.abortAndWait(workspaceRoot, sessionId),
    })).rejects.toBeInstanceOf(LoopBudgetHardStopError);

    const state = await stateManager.read(loop.loopId);
    expect(state.status).toBe("paused");
    expect(state.lastRun).toMatchObject({ status: "budget_exceeded", reason: "hard_budget_exceeded", sessionId: "session-1" });
    executionManager.assertCallCount("abortAndWait", 1);
  });
});

function makeModelInfo(): ModelInfo {
  return new ModelInfo({
    model: {} as never,
    providerId: "test",
    modelId: "priced",
    config: {
      name: "Priced",
      limit: { context: 10_000, output: 1_000 },
      modalities: { input: ["text"], output: ["text"] },
      pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
    },
  });
}
