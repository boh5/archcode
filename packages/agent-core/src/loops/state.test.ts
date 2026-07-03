import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  LoopConfigSchema,
  LoopInvalidIdError,
  LoopPathError,
  LoopRunLogError,
  LoopStateManager,
  LoopStateSchema,
  type LoopConfig,
  type LoopRunReport,
} from "./state";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-state");
const VALID_LOOP_ID = "550e8400-e29b-41d4-a716-446655440000";

const manualConfig: LoopConfig = {
  title: "Daily triage",
  description: "Summarize project status",
  schedule: { kind: "manual" },
  runKind: "session",
  mode: "report",
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 8 },
  taskPrompt: "Summarize open tasks",
};

const intervalConfig: LoopConfig = {
  ...manualConfig,
  title: "Interval triage",
  schedule: { kind: "interval", everyMs: 60_000 },
};

async function captureAsyncError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected async action to throw");
}

function report(loopId: string, runId: string, startedAt: number, status: LoopRunReport["status"] = "succeeded"): LoopRunReport {
  return {
    runId,
    loopId,
    status,
    trigger: "manual",
    startedAt,
    endedAt: startedAt + 100,
    summary: `${runId} summary`,
  };
}

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("Loop schemas", () => {
  test("accept strict loop state and reject unsupported config keys", () => {
    const now = Date.now();
    const state = LoopStateSchema.parse({
      loopId: VALID_LOOP_ID,
      projectId: "project-a",
      config: manualConfig,
      status: "active",
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      stateVersion: 1,
    });

    expect(state.readinessScore).toBeUndefined();
    expect(() => LoopStateSchema.parse({ ...state, extra: true })).toThrow();
    expect(() => LoopConfigSchema.parse({ ...manualConfig, goalTemplateId: "goal-1" })).toThrow();
    expect(() => LoopConfigSchema.parse({ ...manualConfig, schedule: { kind: "cron", expression: "* * * * *" } })).toThrow();
  });
});

describe("LoopStateManager", () => {
  test("creates loop state files and generated markdown", async () => {
    const manager = new LoopStateManager(TMP_DIR);

    const created = await manager.create("project-a", manualConfig, "architect");

    const loopDir = join(TMP_DIR, ".archcode", "loops", created.loopId);
    expect(created).toMatchObject({
      projectId: "project-a",
      config: { title: "Daily triage", schedule: { kind: "manual" } },
      status: "active",
      runCount: 0,
      stateVersion: 1,
    });
    expect(created.loopId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(created.nextRunAt).toBeUndefined();
    expect(created.readinessScore).toBeUndefined();
    expect(existsSync(join(loopDir, "state.json"))).toBe(true);
    expect(existsSync(join(loopDir, "state.md"))).toBe(true);
    expect(await manager.read(created.loopId)).toEqual(created);

    const markdown = await Bun.file(join(loopDir, "state.md")).text();
    expect(markdown).toContain("state.json is the source of truth");
    expect(markdown).toContain("# Daily triage");
  });

  test("list filters by project and sorts by loop id", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const a1 = await manager.create("project-a", { ...manualConfig, title: "A1" });
    const b1 = await manager.create("project-b", { ...manualConfig, title: "B1" });
    const a2 = await manager.create("project-a", { ...manualConfig, title: "A2" });

    expect(new Set((await manager.list("project-a")).map((loop) => loop.loopId))).toEqual(new Set([a1.loopId, a2.loopId]));
    expect((await manager.list()).map((loop) => loop.loopId)).toEqual([a1.loopId, b1.loopId, a2.loopId].sort());
  });

  test("update persists editable config and status fields", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", manualConfig);

    const updated = await manager.update(created.loopId, {
      config: { ...manualConfig, title: "Updated", limits: { maxIterationsPerRun: 3 } },
      status: "disabled",
      generatedStateSummary: "Disabled for maintenance.",
    });

    expect(updated.config.title).toBe("Updated");
    expect(updated.status).toBe("disabled");
    expect(updated.stateVersion).toBe(created.stateVersion + 1);
    expect((await manager.read(created.loopId)).generatedStateSummary).toBe("Disabled for maintenance.");
  });

  test("appendRunReport appends JSONL and readRunLog returns newest reports deterministically", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", manualConfig);
    const first = report(created.loopId, "run-1", 1_000);
    const second = report(created.loopId, "run-2", 2_000);
    const third = report(created.loopId, "run-3", 3_000);

    await manager.appendRunReport(created.loopId, first);
    await manager.appendRunReport(created.loopId, second);
    await manager.appendRunReport(created.loopId, third);

    const runLogPath = join(TMP_DIR, ".archcode", "loops", created.loopId, "run-log.jsonl");
    const rawLines = (await Bun.file(runLogPath).text()).trim().split("\n");
    expect(rawLines.map((line) => JSON.parse(line).runId)).toEqual(["run-1", "run-2", "run-3"]);
    expect((await manager.readRunLog(created.loopId)).map((entry) => entry.runId)).toEqual(["run-3", "run-2", "run-1"]);
    expect((await manager.readRunLog(created.loopId, 2)).map((entry) => entry.runId)).toEqual(["run-3", "run-2"]);
  });

  test("recordRunStart and recordRunFinish update state and append final report", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", intervalConfig);
    const running: LoopRunReport = {
      runId: "run-active",
      loopId: created.loopId,
      status: "running",
      trigger: "interval",
      startedAt: 10_000,
    };

    const started = await manager.recordRunStart(created.loopId, running);
    expect(started.currentRun).toEqual(running);

    const finished = await manager.recordRunFinish(created.loopId, {
      ...running,
      status: "succeeded",
      endedAt: 20_000,
      summary: "done",
    });

    expect(finished.currentRun).toBeUndefined();
    expect(finished.lastRun?.runId).toBe("run-active");
    expect(finished.runCount).toBe(1);
    expect(finished.nextRunAt).toBe(80_000);
    expect((await manager.readRunLog(created.loopId, 1))[0]?.status).toBe("succeeded");
  });

  test("pause preserves currentRun and resume computes interval nextRunAt from injected now", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", intervalConfig);
    const running: LoopRunReport = {
      runId: "run-current",
      loopId: created.loopId,
      status: "running",
      trigger: "interval",
      startedAt: 50_000,
    };
    await manager.recordRunStart(created.loopId, running);

    const paused = await manager.pause(created.loopId);
    expect(paused.status).toBe("paused");
    expect(paused.currentRun).toEqual(running);
    expect(paused.nextRunAt).toBeUndefined();

    const resumed = await manager.resume(created.loopId, 100_000);
    expect(resumed.status).toBe("active");
    expect(resumed.currentRun).toEqual(running);
    expect(resumed.nextRunAt).toBe(160_000);
  });

  test("resume leaves manual loop nextRunAt absent", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", manualConfig);
    await manager.pause(created.loopId);

    const resumed = await manager.resume(created.loopId, 100_000);

    expect(resumed.nextRunAt).toBeUndefined();
  });

  test("rejects path traversal loop ids and contained path escapes", async () => {
    const manager = new LoopStateManager(TMP_DIR);

    expect(await captureAsyncError(() => manager.read("../escape"))).toBeInstanceOf(LoopInvalidIdError);
    expect(await captureAsyncError(() => manager.appendRunReport("../escape", report(VALID_LOOP_ID, "run", 1)))).toBeInstanceOf(LoopInvalidIdError);
    expect(await captureAsyncError(() => manager.resolveContainedPathForTest("../escape/state.json"))).toBeInstanceOf(LoopPathError);
    expect(existsSync(join(TMP_DIR, "escape"))).toBe(false);
  });

  test("rejects run reports for a different loop", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", manualConfig);

    expect(await captureAsyncError(() => manager.appendRunReport(created.loopId, report(VALID_LOOP_ID, "run", 1)))).toBeInstanceOf(LoopRunLogError);
  });

  test("atomic state writes produce valid JSON and no temp files", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", manualConfig);
    await manager.update(created.loopId, { status: "paused" });

    const loopDir = join(TMP_DIR, ".archcode", "loops", created.loopId);
    const content = await Bun.file(join(loopDir, "state.json")).text();
    expect(JSON.parse(content).loopId).toBe(created.loopId);
    expect((await readdir(loopDir)).filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
  });
});
