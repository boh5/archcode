import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { SpecraConfig } from "../config/schema";
import { ModelInfo } from "../provider/model";
import type { Registry as ProviderRegistry } from "../provider/index";
import { SkillService } from "../skills";
import { SessionStoreManager } from "../store/session-store-manager";
import { createRegistry } from "../tools/registry";
import type { AnyToolDescriptor } from "../tools/types";
import { ConcurrentSessionLimitError } from "./errors";
import { orchestratorAgentDefinition } from "./definitions";
import { SessionAgentManager } from "./session-agent-manager";
import { silentLogger } from "../logger";

function makeTool(name: string): AnyToolDescriptor {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}).strict(),
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: () => `${name} result`,
  };
}

function makeProviderRegistry(): ProviderRegistry {
  const model = new ModelInfo({
    model: {} as ConstructorParameters<typeof ModelInfo>[0]["model"],
    config: {
      name: "Test Model",
      limit: { context: 128_000, output: 8_192 },
      modalities: { input: ["text"], output: ["text"] },
    },
    providerId: "test",
    modelId: "model",
  });

  return {
    sdkRegistry: {} as ProviderRegistry["sdkRegistry"],
    models: new Map([[model.qualifiedId, model]]),
    modelIds: [model.qualifiedId],
    getModel: () => model,
  } as ProviderRegistry;
}

function createManager(maxConcurrentSessions = 4, tombstoneTtlMs?: number): SessionAgentManager {
  const providerRegistry = makeProviderRegistry();
  return new SessionAgentManager({
    definitions: [orchestratorAgentDefinition],
    providerRegistry,
    toolRegistry: createRegistry([makeTool("unknown_tool")]),
    skillService: new SkillService({ builtinSkills: {} }),
    storeManager: new SessionStoreManager({ logger: silentLogger }),
    config: {
      provider: {},
      agents: { orchestrator: { model: providerRegistry.modelIds[0]! } },
    } as SpecraConfig,
    logger: silentLogger,
    maxConcurrentSessions,
    ...(tombstoneTtlMs === undefined ? {} : { tombstoneTtlMs }),
  });
}

describe("SessionAgentManager", () => {
  test("enforces per-workspace concurrent session limit", () => {
    const manager = createManager(2);
    const workspaceRoot = "/tmp/specra-workspace";

    manager.acquireSlot(workspaceRoot, "one");
    manager.acquireSlot(workspaceRoot, "two");

    expect(() => manager.acquireSlot(workspaceRoot, "three")).toThrow(ConcurrentSessionLimitError);
    try {
      manager.acquireSlot(workspaceRoot, "three");
    } catch (error) {
      expect(error).toBeInstanceOf(ConcurrentSessionLimitError);
      expect((error as ConcurrentSessionLimitError).name).toBe("ConcurrentSessionLimitError");
      expect((error as ConcurrentSessionLimitError).workspaceRoot).toBe(workspaceRoot);
      expect((error as ConcurrentSessionLimitError).current).toBe(2);
      expect((error as ConcurrentSessionLimitError).max).toBe(2);
    }
  });

  test("releaseSlot frees capacity for the same workspace", () => {
    const manager = createManager(1);
    const workspaceRoot = "/tmp/specra-workspace";

    manager.acquireSlot(workspaceRoot, "one");
    expect(() => manager.acquireSlot(workspaceRoot, "two")).toThrow(ConcurrentSessionLimitError);

    manager.releaseSlot(workspaceRoot, "one");

    expect(() => manager.acquireSlot(workspaceRoot, "two")).not.toThrow();
  });

  test("tombstoned sessions cannot be recreated", async () => {
    const manager = createManager();
    const workspaceRoot = "/tmp/specra-workspace";

    manager.dispose(workspaceRoot, "deleted");

    expect(manager.isTombstoned(workspaceRoot, "deleted")).toBe(true);
    await expect(manager.getOrCreate(workspaceRoot, "deleted")).rejects.toThrow("has been deleted");
  });

  test("concurrent getOrCreate returns the same agent instance", async () => {
    const manager = createManager();
    const workspaceRoot = "/tmp/specra-workspace";

    const [first, second] = await Promise.all([
      manager.getOrCreate(workspaceRoot, "same-session"),
      manager.getOrCreate(workspaceRoot, "same-session"),
    ]);

    expect(first).toBe(second);
    expect(manager.get(workspaceRoot, "same-session")).toBe(first);
  });

  test("tombstone expiry allows recreating a deleted session", async () => {
    const manager = createManager(4, 25);
    const workspaceRoot = "/tmp/specra-workspace";

    manager.dispose(workspaceRoot, "expired");
    expect(manager.isTombstoned(workspaceRoot, "expired")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 35));

    await expect(manager.getOrCreate(workspaceRoot, "expired")).resolves.toBeDefined();
    expect(manager.isTombstoned(workspaceRoot, "expired")).toBe(false);
  });

  test("clearTombstone allows recreating a deleted session", async () => {
    const manager = createManager();
    const workspaceRoot = "/tmp/specra-workspace";

    manager.dispose(workspaceRoot, "cleared");
    expect(manager.clearTombstone(workspaceRoot, "cleared")).toBe(true);

    await expect(manager.getOrCreate(workspaceRoot, "cleared")).resolves.toBeDefined();
    expect(manager.isTombstoned(workspaceRoot, "cleared")).toBe(false);
  });
});
