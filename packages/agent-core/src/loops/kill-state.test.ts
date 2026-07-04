import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { LoopKillStateManager } from "./kill-state";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-kill-state");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("LoopKillStateManager", () => {
  test("defaults to inactive and persists activation metadata", async () => {
    const manager = new LoopKillStateManager(TMP_DIR, { clock: { now: () => 1_000 } });

    expect(await manager.read()).toEqual({ globalKillActive: false });

    const activated = await manager.activate({ activatedBy: "architect", reason: "stop all loops" });
    const reloaded = await new LoopKillStateManager(TMP_DIR).read();

    expect(activated).toEqual({
      globalKillActive: true,
      activatedAt: 1_000,
      activatedBy: "architect",
      reason: "stop all loops",
    });
    expect(reloaded).toEqual(activated);
    expect(await Bun.file(join(TMP_DIR, ".archcode", "loops", "kill-state.json")).exists()).toBe(true);
  });

  test("clear only removes the global block metadata", async () => {
    const manager = new LoopKillStateManager(TMP_DIR, { clock: { now: () => 2_000 } });
    await manager.activate({ activatedBy: "architect", reason: "pause automation" });

    const cleared = await manager.clear();

    expect(cleared).toEqual({ globalKillActive: false });
    expect(await new LoopKillStateManager(TMP_DIR).read()).toEqual({ globalKillActive: false });
  });
});
