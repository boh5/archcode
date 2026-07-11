import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ArchCodeConfig } from "../config/schema";
import { ModelInfo } from "../provider/model";
import type { ProviderRegistry } from "../provider/index";
import { SkillService } from "../skills";
import { SessionStoreManager } from "../store/session-store-manager";
import { createRegistry } from "../tools/registry";
import type { AnyToolDescriptor } from "../tools/types";
import { ConcurrentSessionLimitError } from "./errors";
import { orchestratorAgentDefinition } from "./definitions";
import { SessionAgentManager } from "./session-agent-manager";
import { silentLogger } from "../logger";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSessionPath } from "../store/sessions-dir";
import { createTestProjectContextResolver } from "./test-project-context-resolver";

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

function createManager(
  maxConcurrentSessions = 4,
  tombstoneTtlMs?: number,
  storeManager = new SessionStoreManager({ logger: silentLogger }),
): SessionAgentManager {
  const providerRegistry = makeProviderRegistry();
  return new SessionAgentManager({
    definitions: [orchestratorAgentDefinition],
    providerRegistry,
    toolRegistry: createRegistry([makeTool("unknown_tool")]),
    skillService: new SkillService({ builtinSkills: {} }),
    storeManager,
    projectContextResolver: createTestProjectContextResolver(storeManager),
    config: {
      provider: {},
      agents: { orchestrator: { model: providerRegistry.modelIds[0]! } },
    } as ArchCodeConfig,
    logger: silentLogger,
    maxConcurrentSessions,
    ...(tombstoneTtlMs === undefined ? {} : { tombstoneTtlMs }),
  });
}

describe("SessionAgentManager", () => {
  test("cold missing Session fails closed instead of creating a new identity", async () => {
    const workspaceRoot = join(import.meta.dir, "__test_tmp__", `missing-session-${crypto.randomUUID()}`);
    const sessionId = crypto.randomUUID();
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const manager = createManager(4, undefined, storeManager);

    await expect(manager.getOrCreate(workspaceRoot, sessionId)).rejects.toMatchObject({
      name: "SessionFileNotFoundError",
    });
    expect(storeManager.get(sessionId, workspaceRoot)).toBeUndefined();
  });

  test("cold malformed Session fails closed instead of recreating the same identity", async () => {
    const workspaceRoot = join(import.meta.dir, "__test_tmp__", `malformed-session-${crypto.randomUUID()}`);
    const sessionId = crypto.randomUUID();
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    await mkdir(join(getSessionPath(workspaceRoot, sessionId), ".."), { recursive: true });
    await writeFile(getSessionPath(workspaceRoot, sessionId), "{ malformed json");
    const manager = createManager(4, undefined, storeManager);

    await expect(manager.getOrCreate(workspaceRoot, sessionId)).rejects.toBeDefined();
    expect(storeManager.get(sessionId, workspaceRoot)).toBeUndefined();

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("cold schema-invalid Session fails closed instead of washing persisted identity", async () => {
    const workspaceRoot = join(import.meta.dir, "__test_tmp__", `invalid-session-${crypto.randomUUID()}`);
    const sessionId = crypto.randomUUID();
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    await mkdir(join(getSessionPath(workspaceRoot, sessionId), ".."), { recursive: true });
    await writeFile(getSessionPath(workspaceRoot, sessionId), JSON.stringify({
      sessionId,
      rootSessionId: sessionId,
      cwd: "relative-cwd-must-not-survive",
    }));
    const manager = createManager(4, undefined, storeManager);

    await expect(manager.getOrCreate(workspaceRoot, sessionId)).rejects.toBeDefined();
    expect(storeManager.get(sessionId, workspaceRoot)).toBeUndefined();

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("rejects a persisted Session cwd outside the project repository", async () => {
    const root = join(import.meta.dir, "__test_tmp__", `invalid-cwd-${crypto.randomUUID()}`);
    const projectRoot = join(root, "project");
    const outside = join(root, "outside");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    const git = Bun.spawn(["git", "init", "--initial-branch=main"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
    await git.exited;
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    storeManager.create(sessionId, projectRoot, { cwd: outside });
    const manager = createManager(4, undefined, storeManager);

    await expect(manager.getOrCreate(projectRoot, sessionId)).rejects.toMatchObject({
      name: "InvalidSessionCwdError",
      cwd: outside,
    });
    await rm(root, { recursive: true, force: true });
  });

  test("rejects the canonical checkout through a different persisted path spelling", async () => {
    const root = join(import.meta.dir, "__test_tmp__", `canonical-cwd-alias-${crypto.randomUUID()}`);
    const realProjectRoot = join(root, "project-real");
    const projectRoot = join(root, "project-alias");
    await mkdir(realProjectRoot, { recursive: true });
    const git = Bun.spawn(["git", "init", "--initial-branch=main"], {
      cwd: realProjectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    await git.exited;
    await symlink(realProjectRoot, projectRoot, "dir");
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    storeManager.create(sessionId, projectRoot, { cwd: realProjectRoot });
    const manager = createManager(4, undefined, storeManager);

    await expect(manager.getOrCreate(projectRoot, sessionId)).rejects.toMatchObject({
      name: "InvalidSessionCwdError",
      cwd: realProjectRoot,
    });
    await rm(root, { recursive: true, force: true });
  });

  test("enforces per-workspace concurrent session limit", () => {
    const manager = createManager(2);
    const workspaceRoot = "/tmp/archcode-workspace";

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
    const workspaceRoot = "/tmp/archcode-workspace";

    manager.acquireSlot(workspaceRoot, "one");
    expect(() => manager.acquireSlot(workspaceRoot, "two")).toThrow(ConcurrentSessionLimitError);

    manager.releaseSlot(workspaceRoot, "one");

    expect(() => manager.acquireSlot(workspaceRoot, "two")).not.toThrow();
  });

  test("tombstoned sessions cannot be recreated", async () => {
    const manager = createManager();
    const workspaceRoot = "/tmp/archcode-workspace";

    manager.dispose(workspaceRoot, "deleted");

    expect(manager.isTombstoned(workspaceRoot, "deleted")).toBe(true);
    await expect(manager.getOrCreate(workspaceRoot, "deleted")).rejects.toThrow("has been deleted");
  });

  test("concurrent getOrCreate returns the same agent instance", async () => {
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const manager = createManager(4, undefined, storeManager);
    const workspaceRoot = "/tmp/archcode-workspace";
    const sessionId = crypto.randomUUID();
    storeManager.create(sessionId, workspaceRoot);

    const [first, second] = await Promise.all([
      manager.getOrCreate(workspaceRoot, sessionId),
      manager.getOrCreate(workspaceRoot, sessionId),
    ]);

    expect(first).toBe(second);
    expect(manager.get(workspaceRoot, sessionId)).toBe(first);
  });

  test("dispatchCommand waits for an already-pending Agent registration", async () => {
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const manager = createManager(4, undefined, storeManager);
    const workspaceRoot = "/tmp/archcode-workspace";
    const sessionId = crypto.randomUUID();
    storeManager.create(sessionId, workspaceRoot);

    const pendingAgent = manager.getOrCreate(workspaceRoot, sessionId);

    await expect(manager.dispatchCommand(workspaceRoot, sessionId, "missing-command")).resolves.toEqual({
      success: false,
      message: "Unknown command: missing-command",
    });
    expect(manager.get(workspaceRoot, sessionId)).toBe(await pendingAgent);
  });

  test("tombstone expiry allows recreating a deleted session", async () => {
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const manager = createManager(4, 25, storeManager);
    const workspaceRoot = "/tmp/archcode-workspace";
    const sessionId = crypto.randomUUID();
    storeManager.create(sessionId, workspaceRoot);
    await storeManager.flushSession(sessionId, workspaceRoot);

    manager.dispose(workspaceRoot, sessionId);
    expect(manager.isTombstoned(workspaceRoot, sessionId)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 35));

    await expect(manager.getOrCreate(workspaceRoot, sessionId)).resolves.toBeDefined();
    expect(manager.isTombstoned(workspaceRoot, sessionId)).toBe(false);
  });

  test("clearTombstone allows recreating a deleted session", async () => {
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const manager = createManager(4, undefined, storeManager);
    const workspaceRoot = "/tmp/archcode-workspace";
    const sessionId = crypto.randomUUID();
    storeManager.create(sessionId, workspaceRoot);
    await storeManager.flushSession(sessionId, workspaceRoot);

    manager.dispose(workspaceRoot, sessionId);
    expect(manager.clearTombstone(workspaceRoot, sessionId)).toBe(true);

    await expect(manager.getOrCreate(workspaceRoot, sessionId)).resolves.toBeDefined();
    expect(manager.isTombstoned(workspaceRoot, sessionId)).toBe(false);
  });
});
