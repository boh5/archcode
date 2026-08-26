import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { ModelInfo } from "../provider/model";
import type { ExecutionModelBinding } from "../models";
import { SkillService } from "../skills";
import { BUILTIN_SKILL_PACKAGES } from "../skills/builtin/manifest";
import { SessionStoreManager } from "../store/session-store-manager";
import type { ToolRegistry } from "../tools/registry";
import type { AnyToolDescriptor } from "../tools/types";
import { leadAgentDefinition, exploreAgentDefinition } from "./definitions";
import { createTextToolResult } from "../tools/results";
import { createTestToolRegistryFixture, type TestToolRegistryFixture } from "../tools/test-registry";
import { SessionAgentManager } from "./session-agent-manager";
import { silentLogger } from "../logger";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSessionPath } from "../store/sessions-dir";
import { createTestProjectContextResolver } from "./test-project-context-resolver";
import { setLlmAdapterForTest } from "../llm/adapter";
import { DELEGATION_CONTROL_TOOLS } from "./constants";
import type { AgentDefinition } from "./factory-types";
import type { ToolExecutionContext } from "../tools/types";
import type { DelegationRequest } from "@archcode/protocol";
import { MemoryPolicyRuntime } from "../memory";
import {
  testExecutionLoadedToolRefs,
  testExecutionMemoryPolicy,
  testExecutionToolAuthorizationSnapshot,
} from "../testing/test-execution-fixtures";
import {
  EMPTY_ATTACHMENT_MODEL_PROJECTOR,
  resolveEmptyAttachmentReadPaths,
} from "../attachments/test-helpers";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/types";

const TEST_WORKSPACE_ROOT = join(import.meta.dir, "__test_tmp__", `session-agent-manager-${crypto.randomUUID()}`);
const registryFixtures: TestToolRegistryFixture[] = [];
const outputAccessFixture = createTestToolRegistryFixture();

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolveValue: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => { resolveValue = resolve; });
  return { promise, resolve: resolveValue };
}

function createTestRegistry(descriptors: AnyToolDescriptor[]): ToolRegistry {
  const fixture = createTestToolRegistryFixture({ descriptors });
  registryFixtures.push(fixture);
  return fixture.registry;
}

afterAll(async () => {
  await Promise.all([...registryFixtures, outputAccessFixture].map((fixture) => fixture.dispose()));
  await rm(TEST_WORKSPACE_ROOT, { recursive: true, force: true });
});

afterEach(() => {
  setLlmAdapterForTest(undefined);
});

function makeTool(name: string): AnyToolDescriptor {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}).strict(),
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
    execute: () => createTextToolResult(`${name} result`),
  };
}

function makeBinding(): ExecutionModelBinding {
  const model = new ModelInfo({
    model: {} as ConstructorParameters<typeof ModelInfo>[0]["model"],
    config: {
      name: "Test Model",
      limit: { context: 128_000, output: 8_192 },
      modalities: { input: ["text"], output: ["text"] },
    },
    providerId: "test",
    providerDisplayName: "Test Provider",
    modelId: "model",
  });

  return {
    modelInfo: model,
    options: undefined,
    summary: {
      selection: { model: model.qualifiedId },
      providerId: model.providerId,
      modelId: model.modelId,
      providerDisplayName: model.providerDisplayName,
      modelDisplayName: model.displayName,
      resolution: "profile_default",
      modelRuntimeRevision: "test-revision",
    },
  };
}

function createManager(
  tombstoneTtlMs?: number,
  storeManager = new SessionStoreManager({ logger: silentLogger }),
): SessionAgentManager {
  return new SessionAgentManager({
    definitions: [leadAgentDefinition],
    toolRegistry: createTestRegistry([makeTool("unknown_tool")]),
    skillService: new SkillService({ builtinSkills: {} }),
    storeManager,
    createToolOutputAccess: outputAccessFixture.createToolOutputAccess,
    attachmentProjector: EMPTY_ATTACHMENT_MODEL_PROJECTOR,
    resolveAttachmentReadPaths: resolveEmptyAttachmentReadPaths,
    projectContextResolver: createTestProjectContextResolver(storeManager),
    logger: silentLogger,
    ...(tombstoneTtlMs === undefined ? {} : { tombstoneTtlMs }),
  });
}

const IDENTITY_SKILL_NAME = "identity-skill";
const IDENTITY_SKILL_BODY = "Canonical child identity instructions.";
const identityLeadDefinition = {
  ...leadAgentDefinition,
  roleContract: {
    ...leadAgentDefinition.roleContract,
    delegateTargets: ["explore"],
  },
  tools: {
    authorized: ["file_read", "identity_probe", ...DELEGATION_CONTROL_TOOLS],
    core: ["file_read", "identity_probe"],
    delegateTargets: ["explore"],
  },
  hooks: {
    autoCompact: false,
    autoInjectReminder: false,
    todoStepReminder: false,
    todoQueryLoopContinuation: false,
    titleGeneration: "disabled",
  },
  includeMemoryInPrompt: false,
  skills: [IDENTITY_SKILL_NAME, "orchestrate-work"],
} as const satisfies AgentDefinition;

const identityExploreDefinition = {
  ...exploreAgentDefinition,
  tools: {
    authorized: ["file_read", "identity_probe"],
    core: ["file_read", "identity_probe"],
  },
  hooks: identityLeadDefinition.hooks,
  includeMemoryInPrompt: false,
  skills: [IDENTITY_SKILL_NAME],
} as const satisfies AgentDefinition;

function setupIdentityProbeStream() {
  const streamText = mock((_options: Record<string, unknown>) => {
    const toolCall = { toolCallId: crypto.randomUUID(), toolName: "identity_probe", input: {} };
    return {
      fullStream: (async function* () {
        yield { type: "tool-call", ...toolCall };
      })(),
      finishReason: Promise.resolve("tool-calls"),
      text: Promise.resolve(""),
      toolCalls: Promise.resolve([toolCall]),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    };
  });
  setLlmAdapterForTest({ streamText: streamText as unknown as typeof import("ai").streamText });
  return streamText;
}

function createIdentityManager(
  storeManager: SessionStoreManager,
  observedContexts: ToolExecutionContext[],
): SessionAgentManager {
  const identityProbe: AnyToolDescriptor = {
    ...makeTool("identity_probe"),
    execute: (_input, context) => {
      observedContexts.push(context);
      return createTextToolResult("identity recorded");
    },
  };
  const toolRegistry = createTestRegistry([
    identityProbe,
    makeTool("file_read"),
    ...DELEGATION_CONTROL_TOOLS.map(makeTool),
  ]);
  const skillService = new SkillService({
    builtinSkills: {
      ...BUILTIN_SKILL_PACKAGES,
      [IDENTITY_SKILL_NAME]: { entry: [
        "---",
        `name: ${IDENTITY_SKILL_NAME}`,
        "description: Identity fixture. Use to verify persisted child identity.",
        "---",
        IDENTITY_SKILL_BODY,
      ].join("\n"), resources: {} },
    },
  });

  return new SessionAgentManager({
    definitions: [identityLeadDefinition, identityExploreDefinition],
    toolRegistry,
    skillService,
    storeManager,
    createToolOutputAccess: outputAccessFixture.createToolOutputAccess,
    attachmentProjector: EMPTY_ATTACHMENT_MODEL_PROJECTOR,
    resolveAttachmentReadPaths: resolveEmptyAttachmentReadPaths,
    projectContextResolver: createTestProjectContextResolver(storeManager),
    logger: silentLogger,
  });
}

describe("SessionAgentManager", () => {
  test("cold missing Session fails closed instead of creating a new identity", async () => {
    const workspaceRoot = join(import.meta.dir, "__test_tmp__", `missing-session-${crypto.randomUUID()}`);
    const sessionId = crypto.randomUUID();
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const manager = createManager(undefined, storeManager);

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
    const manager = createManager(undefined, storeManager);

    await expect(manager.getOrCreate(workspaceRoot, sessionId)).rejects.toBeDefined();
    expect(storeManager.get(sessionId, workspaceRoot)).toBeUndefined();

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("cold schema-invalid Session fails closed", async () => {
    const workspaceRoot = join(import.meta.dir, "__test_tmp__", `invalid-session-${crypto.randomUUID()}`);
    const sessionId = crypto.randomUUID();
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    await mkdir(join(getSessionPath(workspaceRoot, sessionId), ".."), { recursive: true });
    await writeFile(getSessionPath(workspaceRoot, sessionId), JSON.stringify({
      sessionId,
      rootSessionId: sessionId,
      cwd: "relative-cwd-must-not-survive",
    }));
    const manager = createManager(undefined, storeManager);

    await expect(manager.getOrCreate(workspaceRoot, sessionId)).rejects.toBeDefined();
    expect(storeManager.get(sessionId, workspaceRoot)).toBeUndefined();

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("tombstoned sessions cannot be recreated", async () => {
    const manager = createManager();
    const workspaceRoot = TEST_WORKSPACE_ROOT;

    manager.dispose(workspaceRoot, "deleted");

    expect(manager.isTombstoned(workspaceRoot, "deleted")).toBe(true);
    await expect(manager.getOrCreate(workspaceRoot, "deleted")).rejects.toThrow("has been deleted");
  });

  test("concurrent getOrCreate returns the same agent instance", async () => {
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const manager = createManager(undefined, storeManager);
    const workspaceRoot = TEST_WORKSPACE_ROOT;
    const sessionId = crypto.randomUUID();
    storeManager.create(sessionId, workspaceRoot, { source: { kind: "direct" }, agentName: "lead" });

    const [first, second] = await Promise.all([
      manager.getOrCreate(workspaceRoot, sessionId),
      manager.getOrCreate(workspaceRoot, sessionId),
    ]);

    expect(first).toBe(second);
  });

  test("superseded deferred activation cannot register or clear the next generation", async () => {
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const workspaceRoot = TEST_WORKSPACE_ROOT;
    const sessionId = crypto.randomUUID();
    const store = storeManager.create(sessionId, workspaceRoot, {
      source: { kind: "direct" },
      agentName: "lead",
    });
    const firstLoad = deferred<StoreApi<SessionStoreState>>();
    const secondLoad = deferred<StoreApi<SessionStoreState>>();
    const originalGetOrLoad = storeManager.getOrLoad.bind(storeManager);
    let loadCount = 0;
    storeManager.getOrLoad = async (requestedSessionId, requestedWorkspaceRoot) => {
      loadCount += 1;
      if (loadCount === 1) return await firstLoad.promise;
      if (loadCount === 2) return await secondLoad.promise;
      return await originalGetOrLoad(requestedSessionId, requestedWorkspaceRoot);
    };
    const manager = createManager(undefined, storeManager);

    const staleActivation = manager.getOrCreate(workspaceRoot, sessionId);
    void staleActivation.catch(() => undefined);
    manager.releaseAgent(workspaceRoot, sessionId);
    const freshActivation = manager.getOrCreate(workspaceRoot, sessionId);

    firstLoad.resolve(store);
    await expect(staleActivation).rejects.toThrow("was superseded");
    const joinedFreshActivation = manager.getOrCreate(workspaceRoot, sessionId);
    expect(loadCount).toBe(2);

    secondLoad.resolve(store);
    const [fresh, joined] = await Promise.all([freshActivation, joinedFreshActivation]);
    expect(joined).toBe(fresh);
    expect(manager.get(workspaceRoot, sessionId)).toBe(fresh);
    expect(loadCount).toBe(2);
  });

  test("clearTombstone allows recreating a deleted session", async () => {
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const manager = createManager(undefined, storeManager);
    const workspaceRoot = TEST_WORKSPACE_ROOT;
    const sessionId = crypto.randomUUID();
    storeManager.create(sessionId, workspaceRoot, { source: { kind: "direct" }, agentName: "lead" });
    await storeManager.flushSession(sessionId, workspaceRoot);

    manager.dispose(workspaceRoot, sessionId);
    expect(manager.clearTombstone(workspaceRoot, sessionId)).toBe(true);

    await expect(manager.getOrCreate(workspaceRoot, sessionId)).resolves.toBeDefined();
    expect(manager.isTombstoned(workspaceRoot, sessionId)).toBe(false);
  });

  test("expired tombstones allow recreating a deleted session with a controlled clock", async () => {
    const originalDateNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const storeManager = new SessionStoreManager({ logger: silentLogger });
      const manager = createManager(25, storeManager);
      const workspaceRoot = TEST_WORKSPACE_ROOT;
      const sessionId = crypto.randomUUID();
      storeManager.create(sessionId, workspaceRoot, { source: { kind: "direct" }, agentName: "lead" });
      await storeManager.flushSession(sessionId, workspaceRoot);

      manager.dispose(workspaceRoot, sessionId);
      expect(manager.isTombstoned(workspaceRoot, sessionId)).toBe(true);

      now += 26;

      await expect(manager.getOrCreate(workspaceRoot, sessionId)).resolves.toBeDefined();
      expect(manager.isTombstoned(workspaceRoot, sessionId)).toBe(false);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("preserves three-layer child identity across warm cache, releaseAgent, and process restart", async () => {
    const workspaceRoot = join(TEST_WORKSPACE_ROOT, `child-identity-${crypto.randomUUID()}`);
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const observedContexts: ToolExecutionContext[] = [];
    const manager = createIdentityManager(storeManager, observedContexts);
    const streamText = setupIdentityProbeStream();
    const sessionIds = Array.from({ length: 2 }, () => crypto.randomUUID());
    const rootSessionId = sessionIds[0]!;

    const childRequest: DelegationRequest = {
      agent_type: "explore",
      profile: "fast",
      title: "Probe durable child identity",
      objective: "Verify that child identity survives cache and process restart.",
      skills: [IDENTITY_SKILL_NAME],
      background: false,
    };

    for (const [depth, sessionId] of sessionIds.entries()) {
      storeManager.create(sessionId, workspaceRoot, {
        agentName: depth === 0 ? "lead" : "explore",
        activeSkillNames: [IDENTITY_SKILL_NAME],
        rootSessionId,
        ...(depth === 0 ? { source: { kind: "direct" as const } } : {}),
        ...(depth === 0 ? {} : {
          parentSessionId: rootSessionId,
          delegationRequest: childRequest,
        }),
      });
      await storeManager.flushSession(sessionId, workspaceRoot);
    }

    const captureIdentity = async (
      activeManager: SessionAgentManager,
      activeContexts: ToolExecutionContext[],
      sessionId: string,
    ) => {
      const agent = await activeManager.getOrCreate(workspaceRoot, sessionId);
      const contextCount = activeContexts.length;
      const promptCount = streamText.mock.calls.length;
      const messageId = crypto.randomUUID();
      const executionId = `test-${messageId}`;
      const binding = makeBinding();
      agent.store.getState().append({
        type: "execution-start",
        executionId,
        binding: binding.summary,
        memoryPolicy: testExecutionMemoryPolicy,
        origin: "user_message",
        maxSteps: 1,
        executionSkills: [],
        toolAuthorizationSnapshot: testExecutionToolAuthorizationSnapshot,
        loadedToolRefs: testExecutionLoadedToolRefs,
      });
      agent.store.getState().append({
        type: "session.messages_committed",
        executionId,
        messages: [{
          id: messageId,
          role: "user",
          parts: [{ type: "text", id: `${messageId}:text`, text: "probe child identity", createdAt: 1, completedAt: 1 }],
          createdAt: 1,
          completedAt: 1,
          executionId,
          runOrdinal: 0,
          clientRequestId: `request-${messageId}`,
          modelAudit: {
            requested: { mode: "profile_default", selection: binding.summary.selection },
            actual: binding.summary.selection,
          },
        }],
      });
      await agent.run(binding, {
        executionId,
        runOrdinal: 0,
        initialStep: 0,
        maxSteps: 1,
        toolAuthorizationSnapshot: testExecutionToolAuthorizationSnapshot,
        loadedToolRefs: testExecutionLoadedToolRefs,
        reconcileExecutionToolLoads: async () => {},
        memoryPolicy: new MemoryPolicyRuntime().claim(),
      });
      const endedAt = Date.now();
      agent.store.getState().append({
        type: "execution-end",
        executionId,
        terminalStatus: "completed",
        endedAt,
        runEndedAt: endedAt,
        runUsageDelta: agent.store.getState().stats.usage,
        runSettlement: { key: `run:${sessionId}:${executionId}:0`, goalInstanceId: null },
        terminalSettlement: { key: `terminal:${sessionId}:${executionId}`, goalInstanceId: null },
      });
      await storeManager.flushSession(sessionId, workspaceRoot);
      const context = activeContexts[contextCount]!;
      const prompt = (streamText.mock.calls[promptCount]![0] as { system: string }).system;
      const depth = context.currentDepth!;
      const factory = activeManager.getFactory(workspaceRoot);
      const definition = factory.getDefinition(agent.store.getState().agentName);

      return {
        depth,
        allowedTools: [...context.allowedTools].sort(),
        delegateTargets: factory.resolveDelegationCapabilities(definition.name, depth).targets.map((target) => target.agentName),
        activeSkillNames: [...agent.store.getState().activeSkillNames],
        hasActiveSkillBody: prompt.includes(IDENTITY_SKILL_BODY),
      };
    };

    const warmIdentities = [];
    for (const [expectedDepth, sessionId] of sessionIds.entries()) {
      const warmAgent = await manager.getOrCreate(workspaceRoot, sessionId);
      expect(await manager.getOrCreate(workspaceRoot, sessionId)).toBe(warmAgent);
      const warmIdentity = await captureIdentity(manager, observedContexts, sessionId);

      manager.releaseAgent(workspaceRoot, sessionId);
      const rebuiltAgent = await manager.getOrCreate(workspaceRoot, sessionId);
      expect(rebuiltAgent).not.toBe(warmAgent);
      const rebuiltIdentity = await captureIdentity(manager, observedContexts, sessionId);

      expect(warmIdentity).toEqual({
        depth: expectedDepth,
        allowedTools: ["file_read", "identity_probe"].sort(),
        delegateTargets: expectedDepth === 0 ? ["explore"] : [],
        activeSkillNames: [IDENTITY_SKILL_NAME],
        hasActiveSkillBody: true,
      });
      expect(rebuiltIdentity).toEqual(warmIdentity);
      warmIdentities.push(warmIdentity);
    }

    const restartedStoreManager = new SessionStoreManager({ logger: silentLogger });
    const restartedContexts: ToolExecutionContext[] = [];
    const restartedManager = createIdentityManager(restartedStoreManager, restartedContexts);
    for (const [depth, sessionId] of sessionIds.entries()) {
      const restartedIdentity = await captureIdentity(restartedManager, restartedContexts, sessionId);
      expect(restartedIdentity).toEqual(warmIdentities[depth]!);
    }
  });
});
