import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { LoopKillStateError, LoopKillStateManager } from "./kill-state";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-kill-state");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await rm(join(TMP_DIR, "..", "outside-archcode"), { recursive: true, force: true }).catch(() => {});
  await rm(join(TMP_DIR, "..", "outside-loops"), { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await rm(join(TMP_DIR, "..", "outside-archcode"), { recursive: true, force: true }).catch(() => {});
  await rm(join(TMP_DIR, "..", "outside-loops"), { recursive: true, force: true }).catch(() => {});
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
    const persistedFile = Bun.file(join(TMP_DIR, ".archcode", "loops", "kill-state.json"));
    expect(await persistedFile.json()).toEqual({ version: 1, state: activated });
  });

  test("hard-fails an unversioned persisted kill state", async () => {
    const filePath = join(TMP_DIR, ".archcode", "loops", "kill-state.json");
    await mkdir(join(TMP_DIR, ".archcode", "loops"), { recursive: true });
    await Bun.write(filePath, JSON.stringify({ globalKillActive: false }));

    await expect(new LoopKillStateManager(TMP_DIR).read()).rejects.toBeInstanceOf(LoopKillStateError);
  });

  test("clear only removes the global block metadata", async () => {
    const manager = new LoopKillStateManager(TMP_DIR, { clock: { now: () => 2_000 } });
    await manager.activate({ activatedBy: "architect", reason: "pause automation" });

    const cleared = await manager.clear();

    expect(cleared).toEqual({ globalKillActive: false });
    expect(await new LoopKillStateManager(TMP_DIR).read()).toEqual({ globalKillActive: false });
  });

  test("rejects a symlinked .archcode directory that escapes the workspace", async () => {
    const outside = join(TMP_DIR, "..", "outside-archcode");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(TMP_DIR, ".archcode"), "dir");

    await expect(new LoopKillStateManager(TMP_DIR).activate()).rejects.toThrow(/Symlink resolves outside the workspace/);
    expect(await Bun.file(join(outside, "loops", "kill-state.json")).exists()).toBe(false);
  });

  test("rejects a symlinked loops directory that escapes the workspace", async () => {
    const outside = join(TMP_DIR, "..", "outside-loops");
    await mkdir(outside, { recursive: true });
    await mkdir(join(TMP_DIR, ".archcode"), { recursive: true });
    await symlink(outside, join(TMP_DIR, ".archcode", "loops"), "dir");

    await expect(new LoopKillStateManager(TMP_DIR).activate()).rejects.toThrow(/Symlink resolves outside the workspace/);
    expect(await Bun.file(join(outside, "kill-state.json")).exists()).toBe(false);
  });
});
