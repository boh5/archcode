import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { LoopPollStateManager, LoopPollStateSecurityError } from "./poll-state";
import { FakeClock } from "./test-utils";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-poll-state");
const LOOP_ID = "7f9f9194-cb2d-4a63-a297-5029888f1827";

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await rm(join(TMP_DIR, "..", "outside-poll-state-archcode"), { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await rm(join(TMP_DIR, "..", "outside-poll-state-archcode"), { recursive: true, force: true }).catch(() => {});
});

describe("LoopPollStateManager", () => {
  test("persists per-loop trigger cursors under poll-state.json", async () => {
    const clock = new FakeClock(1_000);
    const manager = new LoopPollStateManager({ workspaceRoot: TMP_DIR, clock });

    await manager.updateCursor(LOOP_ID, "kind=on_commit|branch=main", (_current, now) => ({
      cursorKey: "kind=on_commit|branch=main",
      kind: "on_commit",
      lastCheckedAt: now,
      lastSuccessAt: now,
      localBranchHeads: { main: "abc123" },
    }));

    const restarted = new LoopPollStateManager({ workspaceRoot: TMP_DIR, clock: new FakeClock(2_000) });
    const state = await restarted.read(LOOP_ID);
    const filePath = await restarted.statePath(LOOP_ID);

    expect(filePath).toBe(join(TMP_DIR, ".archcode", "loops", LOOP_ID, "poll-state.json"));
    expect(state.cursors["kind=on_commit|branch=main"]?.localBranchHeads?.main).toBe("abc123");
    expect((await readdir(join(TMP_DIR, ".archcode", "loops", LOOP_ID))).filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
  });

  test("rejects symlinked poll-state roots that escape the workspace", async () => {
    const outside = join(TMP_DIR, "..", "outside-poll-state-archcode");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(TMP_DIR, ".archcode"), "dir");

    const manager = new LoopPollStateManager({ workspaceRoot: TMP_DIR });

    await expect(manager.updateCursor(LOOP_ID, "kind=on_pr", () => ({ cursorKey: "kind=on_pr", kind: "on_pr" }))).rejects.toBeInstanceOf(LoopPollStateSecurityError);
    expect(await Bun.file(join(outside, "loops", LOOP_ID, "poll-state.json")).exists()).toBe(false);
  });
});
