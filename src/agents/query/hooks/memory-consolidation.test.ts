import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createMemoryConsolidationHook } from "./memory-consolidation";
import { CONSOLIDATION_THRESHOLD } from "../../../memory/constants";
import { createSessionStore } from "../../../store/store";

const mockDispatch = mock(() => {});
const mockBtm = { dispatch: mockDispatch };

const mockProviderRegistry = {
  modelIds: ["test:model"],
  getModel: mock(() => ({ model: {} })),
};

const tmpDir = resolve(import.meta.dir, "__test_tmp__");

function makeStore() {
  return createSessionStore(crypto.randomUUID());
}

describe("createMemoryConsolidationHook", () => {
  beforeEach(async () => {
    mockDispatch.mockReset();
    mockDispatch.mockImplementation(() => {});
    mockProviderRegistry.getModel.mockReset();
    mockProviderRegistry.getModel.mockImplementation(() => ({ model: {} }));
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
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
    const ctx = { store, modelInfo: undefined as never };

    const hook = createMemoryConsolidationHook(
      mockBtm as never,
      mockProviderRegistry as never,
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
    const ctx = { store, modelInfo: undefined as never };

    const hook = createMemoryConsolidationHook(
      mockBtm as never,
      mockProviderRegistry as never,
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
    const ctx = { store, modelInfo: undefined as never };

    const hook = createMemoryConsolidationHook(
      mockBtm as never,
      mockProviderRegistry as never,
      { project: projectRoot, user: userRoot },
    );

    await hook(ctx as never);

    expect(mockDispatch).not.toHaveBeenCalled();
  });
});