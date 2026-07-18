import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryConsolidationHook } from "./memory-consolidation";
import { CONSOLIDATION_THRESHOLD } from "../../../memory/constants";
import { storeManager } from "../../../store/store";
import { createTestTempRoot } from "../../../testing/test-temp-root";

const mockDispatch = mock(() => {});
const mockBtm = { dispatch: mockDispatch };

const testTemp = createTestTempRoot("memory-consolidation-hook");
const tmpDir = testTemp.path;
const sessionIds = new Set<string>();

function makeStore() {
  const sessionId = crypto.randomUUID();
  sessionIds.add(sessionId);
  return storeManager.create(sessionId, tmpDir, { agentName: "engineer" });
}

describe("createMemoryConsolidationHook", () => {
  beforeEach(async () => {
    mockDispatch.mockReset();
    mockDispatch.mockImplementation(() => {});
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await Promise.all([...sessionIds].map((sessionId) => storeManager.flushSession(sessionId, tmpDir)));
    for (const sessionId of sessionIds) storeManager.delete(sessionId, tmpDir);
    sessionIds.clear();
    await testTemp.cleanup();
  });

  test("dispatches memory-consolidation when index exceeds threshold", async () => {
    const projectRoot = join(tmpDir, "over-threshold");
    const userRoot = join(tmpDir, "over-threshold-user");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userRoot, { recursive: true });

    const lines = Array.from({ length: 260 }, (_, i) =>
      `- [Topic ${i}](knowledge/topic${i}.md) — Summary for topic ${i}`,
    ).join("\n");
    await writeFile(join(projectRoot, "index.md"), lines + "\n");

    const store = makeStore();
    const ctx = { store, binding: undefined as never };

    const hook = createMemoryConsolidationHook(
      mockBtm as never,
      { project: projectRoot, user: userRoot },
    );

    await hook(ctx as never);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(
      "memory-consolidation",
      expect.any(Function),
    );
  });

  test("skips dispatch when index is at or below threshold", async () => {
    const projectRoot = join(tmpDir, "at-threshold");
    const userRoot = join(tmpDir, "at-threshold-user");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userRoot, { recursive: true });

    const lines = Array.from({ length: 250 }, (_, i) =>
      `- [Topic ${i}](knowledge/topic${i}.md) — Summary for topic ${i}`,
    ).join("\n");
    await writeFile(join(projectRoot, "index.md"), lines + "\n");

    const store = makeStore();
    const ctx = { store, binding: undefined as never };

    const hook = createMemoryConsolidationHook(
      mockBtm as never,
      { project: projectRoot, user: userRoot },
    );

    await hook(ctx as never);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("skips dispatch when index file does not exist", async () => {
    const projectRoot = join(tmpDir, "no-index");
    const userRoot = join(tmpDir, "no-index-user");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userRoot, { recursive: true });

    const store = makeStore();
    const ctx = { store, binding: undefined as never };

    const hook = createMemoryConsolidationHook(
      mockBtm as never,
      { project: projectRoot, user: userRoot },
    );

    await hook(ctx as never);

    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
