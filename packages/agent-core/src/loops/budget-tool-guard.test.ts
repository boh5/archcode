import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { SkillService } from "../skills";
import { createSessionStore } from "../store/store";
import { SessionStoreManager } from "../store/session-store-manager";
import { createToolExecutionContext } from "../tools/types";
import { createRegistry } from "../tools/registry";
import type { ToolExecutionContext } from "../tools/types";
import { silentLogger } from "../logger";
import { ProjectContextResolver } from "../projects/context-resolver";
import { createLoopBudgetToolPermission } from "./budget-tool-guard";
import { LoopBudgetConfigSchema, LoopStateManager, type LoopBudgetConfig, type LoopConfig } from "./state";
import { FakeClock, FakeSessionExecutionManager, makeEffectfulTestTools, makeReadOnlyTestTools } from "./test-utils";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-budget-tool-guard");
const storeManager = new SessionStoreManager({ logger: silentLogger });

const config: LoopConfig = {
  templateId: "watch_report",
  title: "Guarded loop",
  schedule: { kind: "manual" },
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 4, maxTokensPerRun: 1_000, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
};

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("createLoopBudgetToolPermission", () => {
  test("allows read-only tools but blocks effectful tools at soft threshold", async () => {
    const fixture = await createFixture();
    await fixture.stateManager.updateBudgetSnapshot(fixture.loopId, {
      budget: normalizedBudget(fixture.loop.config.limits),
      usage: {
        iterations: 1,
        inputTokens: 800,
        outputTokens: 0,
        totalTokens: 800,
        wallClockMs: 10,
        runsToday: 1,
        resetDateUtc: "2026-07-04",
        pricingUnavailable: true,
      },
      updatedAt: fixture.clock.now(),
    });

    const readOnly = await fixture.registry.execute({ toolCallId: "read-1", toolName: "file_read", input: {} }, fixture.context("file_read"));
    const effectful = await fixture.registry.execute({ toolCallId: "write-1", toolName: "file_write", input: {} }, fixture.context("file_write"));

    expect(readOnly.isError).toBe(false);
    expect(effectful.isError).toBe(true);
    expect(effectful.output).toContain("LOOP_SOFT_BUDGET_BLOCKED");
    expect((await fixture.stateManager.read(fixture.loopId)).status).toBe("active");
  });

  test("hard threshold blocks effectful tools, records budget_exceeded, pauses loop, and signals abort", async () => {
    const fixture = await createFixture();
    await fixture.stateManager.recordRunStart(fixture.loopId, {
      runId: "run-1",
      loopId: fixture.loopId,
      status: "running",
      trigger: "manual",
      startedAt: fixture.clock.now(),
      sessionId: "session-1",
    });
    await fixture.stateManager.updateBudgetSnapshot(fixture.loopId, {
      budget: normalizedBudget(fixture.loop.config.limits),
      usage: {
        iterations: 4,
        inputTokens: 1_000,
        outputTokens: 0,
        totalTokens: 1_000,
        wallClockMs: 10,
        runsToday: 1,
        resetDateUtc: "2026-07-04",
        pricingUnavailable: true,
      },
      updatedAt: fixture.clock.now(),
    });

    const result = await fixture.registry.execute({ toolCallId: "write-1", toolName: "file_write", input: {} }, fixture.context("file_write"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("LOOP_HARD_BUDGET_EXCEEDED");
    const state = await fixture.stateManager.read(fixture.loopId);
    expect(state.status).toBe("paused");
    expect(state.lastRun).toMatchObject({ status: "budget_exceeded", reason: "hard_budget_exceeded" });
    fixture.executionManager.assertCallCount("abortAndWait", 1);
  });
});

async function createFixture() {
  const clock = new FakeClock(Date.UTC(2026, 6, 4, 12, 0, 0));
  const stateManager = new LoopStateManager(TMP_DIR);
  const loop = await stateManager.create("project-a", config);
  const resolver = new ProjectContextResolver({ projectInfoFactory: () => ({ slug: "project-a", name: "Project A", workspaceRoot: TMP_DIR, addedAt: "2026-07-04T00:00:00.000Z" }) });
  const projectContext = await resolver.resolve(TMP_DIR);
  const registry = createRegistry([...makeReadOnlyTestTools(), ...makeEffectfulTestTools()]);
  registry.globalPermissions.push(createLoopBudgetToolPermission());
  const store = createSessionStore("session-1");
  store.setState({ loopId: loop.loopId });
  const executionManager = new FakeSessionExecutionManager();

  function context(toolName: string): ToolExecutionContext {
    return createToolExecutionContext({
      store,
      storeManager,
      toolName,
      toolCallId: `${toolName}-call`,
      input: {},
      step: 0,
      abort: new AbortController().signal,
      startedAt: clock.now(),
      allowedTools: new Set([toolName]),
      projectContext,
      agentSkills: [],
      skillService: new SkillService({ builtinSkills: {} }),
      origin: { kind: "loop", loopId: loop.loopId, runId: "run-1", trigger: "manual", approvalPolicy: "interactive" },
      abortSessionExecutionAndWait: (workspaceRoot, sessionId) => executionManager.abortAndWait(workspaceRoot, sessionId),
    });
  }

  return { clock, stateManager, loop, loopId: loop.loopId, registry, context, executionManager };
}

function normalizedBudget(value: unknown): LoopBudgetConfig {
  return LoopBudgetConfigSchema.parse(value);
}
