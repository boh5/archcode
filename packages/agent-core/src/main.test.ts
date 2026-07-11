import { afterAll, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { GlobalSSESessionRuntimeChangedEvent, SessionHitlCheckpoint } from "@archcode/protocol";
import type { ResolvedMcpConfig } from "./config/mcp";
import {
  getSessionHitlCheckpointPath,
  writeSessionHitlCheckpoint,
} from "./execution/session-hitl-checkpoint";
import { redactMcpMessage, type McpDiscoveryResult, type McpManager, type McpWarning } from "./mcp/index";
import { SessionStoreManager } from "./store/session-store-manager";
import { storeManager } from "./store/store";
import { defineTool, REDACTION_MARKER, type ToolExecutionContext } from "./tools/index";
import type { AnyToolDescriptor } from "./tools/types";
import { createRuntime } from "./runtime";
import { createTestProjectContext } from "./tools/test-project-context";
import { createInMemoryLogger } from "./logger";
const tmpRoots: string[] = [];

afterAll(() => {
  for (const root of tmpRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeProviderConfig() {
  return {
    local: {
      npm: "@ai-sdk/openai-compatible",
      name: "Local LLM",
      options: {
        baseURL: "http://localhost:8090/v1",
        apiKey: "test-key",
      },
      models: {
        "test-model": {
          name: "Test Model",
          limit: { context: 128000, output: 8192 },
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    },
  };
}

async function writeConfig(config: Record<string, unknown>): Promise<string> {
  const root = await makeTempRoot();
  const configPath = join(root, ".archcode.json");
  await Bun.write(configPath, JSON.stringify(config));
  return configPath;
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "archcode-main-"));
  tmpRoots.push(root);
  return root;
}

function makeConfig(mcp?: Record<string, unknown>): Record<string, unknown> {
  const config = {
    provider: makeProviderConfig(),
    agents: {
      orchestrator: { model: "local:test-model" },
      plan: { model: "local:test-model" },
      build: { model: "local:test-model" },
      reviewer: { model: "local:test-model" },
      explore: { model: "local:test-model" },
      librarian: { model: "local:test-model" },
    },
  };

  return mcp === undefined
    ? config
    : { ...config, mcp };
}

function makeMcpDescriptor(name = "mcp__context7__lookup"): AnyToolDescriptor {
  return defineTool({
    name,
    description: "Fake MCP lookup tool",
    inputSchema: z.object({}).catchall(z.unknown()),
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async () => "mcp output with sk_test_main_secret",
  });
}

function makeFakeMcpManager(
  result: McpDiscoveryResult | Error,
  secrets: readonly string[] = [],
): McpManager {
  return {
    discover: mock(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
    closeAll: mock(async () => []),
    getStatus: mock(() => new Map<string, import("@archcode/protocol").McpServerStatus>()),
    onStatusChange: mock(() => () => {}),
    startBackgroundDiscovery: mock(
      (
        onDescriptors: (descriptors: AnyToolDescriptor[]) => void,
        onWarning: (warning: McpWarning) => void,
      ): void => {
        if (result instanceof Error) {
          onWarning({
            message: redactMcpMessage(
              `Failed to discover MCP tools during startup: ${result.message}`,
              secrets,
            ),
          });
          return;
        }
        for (const warning of result.warnings) {
          onWarning(warning);
        }
        if (result.descriptors.length > 0) {
          onDescriptors(result.descriptors);
        }
      },
    ),
  } as unknown as McpManager;
}

function makeContext(toolName: string, input: unknown): ToolExecutionContext {
  const workspaceRoot = import.meta.dir;
  return {
    store: storeManager.create(`main-test-${crypto.randomUUID()}`, workspaceRoot),
    storeManager,
    toolName,
    toolCallId: `${toolName}-call`,
    input,
    step: 0,
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set([toolName]),
    cwd: workspaceRoot,
    projectContext: createTestProjectContext(workspaceRoot),
  };
}

function sessionHitlBlocker(sessionId: string, hitlId: string): SessionHitlCheckpoint {
  return {
    version: 1,
    hitlId,
    blockingKey: `session:${sessionId}:bash-1`,
    source: { type: "tool_permission", sessionId, toolCallId: "bash-1", toolName: "bash" },
    toolCallId: "bash-1",
    toolName: "bash",
    step: 0,
    displayInput: { command: "while true; do sleep 1; done" },
    blockedAt: new Date().toISOString(),
    reason: "Waiting for permission",
  };
}

async function writeSessionPermissionCheckpoint(input: {
  readonly workspaceRoot: string;
  readonly projectSlug: string;
  readonly sessionId: string;
  readonly hitlId: string;
}): Promise<void> {
  const createdAt = new Date().toISOString();
  await writeSessionHitlCheckpoint({
    version: 1,
    phase: "paused",
    phaseUpdatedAt: createdAt,
    hitlId: input.hitlId,
    blockingKey: `session:${input.sessionId}:bash-1`,
    source: { type: "tool_permission", sessionId: input.sessionId, toolCallId: "bash-1", toolName: "bash" },
    request: {
      owner: { projectSlug: input.projectSlug, ownerType: "session", ownerId: input.sessionId },
      displayPayload: { title: "Run command", summary: "Run a long command", redacted: true },
      createdAt,
    },
    toolCallId: "bash-1",
    toolName: "bash",
    step: 0,
    rawToolInput: { command: "while true; do sleep 1; done" },
    displayInput: { command: "while true; do sleep 1; done" },
    allowedTools: ["bash"],
    agentSkills: [],
    agentName: "orchestrator",
    toolCalls: [{ toolCallId: "bash-1", toolName: "bash", input: { command: "while true; do sleep 1; done" } }],
    completedToolResults: [],
    pendingToolCalls: [{ toolCallId: "bash-1", toolName: "bash", input: { command: "while true; do sleep 1; done" } }],
    blockedToolIndex: 0,
    createdAt,
    kind: "permission",
    permission: { description: "Run a long command" },
  }, input.workspaceRoot, input.sessionId);
}

describe("createRuntime", () => {
  test("constructs runtime without booting server concerns", async () => {
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    const manager = makeFakeMcpManager({ descriptors: [], warnings: [] });
    const runtime = await createRuntime({
      configPath,
      mcpManagerFactory: () => manager,
    });

    expect(runtime.toolRegistry).toBeDefined();
    expect(runtime.startSessionExecution).toBeDefined();
    expect(runtime.subscribeSessionEvents).toBeDefined();
  });

  test("registers MCP descriptors before the agent run snapshot without calling run", async () => {
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    const mcpDescriptor = makeMcpDescriptor();
    const manager = makeFakeMcpManager({ descriptors: [mcpDescriptor], warnings: [] });
    const runtime = await createRuntime({
      configPath,
      mcpManagerFactory: () => manager,
    });

    expect(runtime.toolRegistry.get(mcpDescriptor.name)).toBe(mcpDescriptor);
    const namesAtRun = runtime.toolRegistry.getAll().map((descriptor) => descriptor.name);

    expect(namesAtRun).toContain(mcpDescriptor.name);
  });

  test("starts with no mcp config", async () => {
    const configPath = await writeConfig(makeConfig());
    let resolvedConfig: ResolvedMcpConfig | undefined;
    const manager = makeFakeMcpManager({ descriptors: [], warnings: [] });

    const runtime = await createRuntime({
      configPath,
      mcpManagerFactory: (config) => {
        resolvedConfig = config;
        return manager;
      },
    });

    expect(resolvedConfig).toEqual({ servers: {} });
    expect(runtime.warnings).toEqual([]);
  });

  test("runtime exposes project registry and shared context resolver", async () => {
    const configPath = await writeConfig(makeConfig());
    const manager = makeFakeMcpManager({ descriptors: [], warnings: [] });

    const runtime = await createRuntime({
      configPath,
      mcpManagerFactory: () => manager,
    });

    expect(runtime.projectRegistry).toBeDefined();
    expect(runtime.contextResolver).toBeDefined();
  });

  test("runtime exposes core-owned agent job lifecycle APIs", async () => {
    const configPath = await writeConfig(makeConfig());
    const manager = makeFakeMcpManager({ descriptors: [], warnings: [] });

    const runtime = await createRuntime({
      configPath,
      mcpManagerFactory: () => manager,
    });

    expect(runtime.getSessionFamilyActivity("/workspace", "missing")).toBe("idle");
    expect(runtime.getSessionExecution("/workspace", "missing")).toBeUndefined();
    await expect(runtime.stopSessionFamily("/workspace", "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      name: "SessionFileNotFoundError",
    });
  });

  test("runtime emits an authoritative snapshot that omits idle Session families", async () => {
    const configPath = await writeConfig(makeConfig());
    const projectRegistryHomeDir = await makeTempRoot();
    const workspaceRoot = await makeTempRoot();
    const manager = makeFakeMcpManager({ descriptors: [], warnings: [] });
    const runtime = await createRuntime({
      configPath,
      projectRegistryHomeDir,
      mcpManagerFactory: () => manager,
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Runtime snapshot" });
    const session = await runtime.createSession(workspaceRoot);
    const changes: GlobalSSESessionRuntimeChangedEvent[] = [];
    const unsubscribe = runtime.subscribeSessionRuntimeChanges((event) => changes.push(event));

    const events = await runtime.listSessionRuntimeEvents();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "session.runtime.snapshot",
      projectSlugs: [project.slug],
      families: [],
    });
    expect(typeof events[0]?.createdAt).toBe("number");
    const projectSnapshot = await runtime.getProjectControlPlaneSnapshot(workspaceRoot, project.slug);
    expect(projectSnapshot).toMatchObject({
      sessionRuntime: {
        type: "session.runtime.snapshot",
        projectSlugs: [project.slug],
        families: [],
      },
      hitl: {
        type: "hitl.snapshot",
        projectSlugs: [project.slug],
        projections: [],
      },
    });
    await expect(runtime.stopSessionFamily(workspaceRoot, session.sessionId)).resolves.toBeUndefined();
    expect(changes.map(({ projectSlug, rootSessionId, activity }) => ({ projectSlug, rootSessionId, activity }))).toEqual([
      { projectSlug: project.slug, rootSessionId: session.sessionId, activity: "stopping" },
      { projectSlug: project.slug, rootSessionId: session.sessionId, activity: "idle" },
    ]);
    unsubscribe();
  });

  test("project removal disposes old runtime state, emits empty snapshots, and re-adds the workspace with a fresh slug context", async () => {
    const configPath = await writeConfig(makeConfig());
    const projectRegistryHomeDir = await makeTempRoot();
    const workspaceRoot = await makeTempRoot();
    const manager = makeFakeMcpManager({ descriptors: [], warnings: [] });
    const runtime = await createRuntime({
      configPath,
      projectRegistryHomeDir,
      mcpManagerFactory: () => manager,
    });
    const originalProject = await runtime.projectRegistry.add({ workspaceRoot, name: "Original Project" });
    const session = await runtime.createSession(workspaceRoot);
    const originalContext = await runtime.contextResolver.resolve(workspaceRoot);
    const record = await originalContext.hitl.create({
      owner: { projectSlug: originalProject.slug, ownerType: "session", ownerId: session.sessionId },
      sessionRootId: session.sessionId,
      blockingKey: `session:${session.sessionId}:remove-project`,
      source: { type: "ask_user", sessionId: session.sessionId, toolCallId: "remove-project" },
      displayPayload: { title: "Continue?", redacted: true },
    });
    const realtimeProjectSlugs: string[] = [];
    const unsubscribe = runtime.subscribeHitlEvents((event) => realtimeProjectSlugs.push(event.projectSlug));

    const removed = await runtime.removeProject(originalProject.slug);
    await originalContext.hitl.publishRequest(record);

    expect(removed).toMatchObject({
      project: originalProject,
      snapshot: {
        sessionRuntime: {
          type: "session.runtime.snapshot",
          projectSlugs: [originalProject.slug],
          families: [],
        },
        hitl: {
          type: "hitl.snapshot",
          projectSlugs: [originalProject.slug],
          projections: [],
        },
      },
    });
    expect(await runtime.projectRegistry.get(originalProject.slug)).toBeUndefined();
    expect(realtimeProjectSlugs).toEqual([]);

    const readded = await runtime.projectRegistry.add({ workspaceRoot, name: "Fresh Project" });
    const freshContext = await runtime.contextResolver.resolve(workspaceRoot);
    const migrated = await freshContext.hitl.lookup({
      owner: { projectSlug: readded.slug, ownerType: "session", ownerId: session.sessionId },
      hitlId: record.hitlId,
    });
    const runtimeSnapshots = await runtime.listSessionRuntimeEvents();

    expect(readded.slug).toBe("fresh-project");
    expect(freshContext).not.toBe(originalContext);
    expect(migrated).toMatchObject({
      status: "found",
      record: { hitlId: record.hitlId, owner: { projectSlug: readded.slug } },
    });
    expect(runtimeSnapshots[0]?.projectSlugs).toEqual([readded.slug]);
    unsubscribe();
  });

  test("public family Stop cancels active Session HITL and clears every durable family blocker before becoming idle", async () => {
    const configPath = await writeConfig(makeConfig());
    const projectRegistryHomeDir = await makeTempRoot();
    const workspaceRoot = await makeTempRoot();
    const manager = makeFakeMcpManager({ descriptors: [], warnings: [] });
    const runtime = await createRuntime({
      configPath,
      projectRegistryHomeDir,
      mcpManagerFactory: () => manager,
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Runtime Stop" });
    const logger = createInMemoryLogger().logger;
    const persistedSessions = new SessionStoreManager({ logger });
    const rootSessionId = crypto.randomUUID();
    const childSessionId = crypto.randomUUID();
    const unrelatedSessionId = crypto.randomUUID();
    const rootStore = persistedSessions.create(rootSessionId, workspaceRoot);
    const childStore = persistedSessions.create(childSessionId, workspaceRoot, {
      rootSessionId,
      parentSessionId: rootSessionId,
      agentName: "build",
      sessionRole: "build",
    });
    persistedSessions.create(unrelatedSessionId, workspaceRoot);
    await Promise.all([
      persistedSessions.flushSession(rootSessionId, workspaceRoot),
      persistedSessions.flushSession(childSessionId, workspaceRoot),
      persistedSessions.flushSession(unrelatedSessionId, workspaceRoot),
    ]);

    const context = await runtime.contextResolver.resolve(workspaceRoot);
    const rootHitlId = crypto.randomUUID();
    const childHitlId = crypto.randomUUID();
    const unrelatedHitlId = crypto.randomUUID();
    const createPermission = (sessionId: string, sessionRootId: string, hitlId: string) => context.hitl.create({
      owner: { projectSlug: project.slug, ownerType: "session" as const, ownerId: sessionId },
      sessionRootId,
      hitlId,
      blockingKey: `session:${sessionId}:bash-1`,
      source: { type: "tool_permission" as const, sessionId, toolCallId: "bash-1", toolName: "bash" },
      displayPayload: { title: "Run command", summary: "Run a long command", redacted: true as const },
    });
    await Promise.all([
      createPermission(rootSessionId, rootSessionId, rootHitlId),
      createPermission(childSessionId, rootSessionId, childHitlId),
      createPermission(unrelatedSessionId, unrelatedSessionId, unrelatedHitlId),
    ]);

    rootStore.getState().append({
      type: "execution-end",
      status: "waiting_for_human",
      blockedByHitlIds: [rootHitlId],
      blockedToolCallId: "bash-1",
      blockedHitl: sessionHitlBlocker(rootSessionId, rootHitlId),
    });
    childStore.getState().append({
      type: "execution-end",
      status: "waiting_for_human",
      blockedByHitlIds: [childHitlId],
      blockedToolCallId: "bash-1",
      blockedHitl: sessionHitlBlocker(childSessionId, childHitlId),
    });
    await Promise.all([
      persistedSessions.flushSession(rootSessionId, workspaceRoot),
      persistedSessions.flushSession(childSessionId, workspaceRoot),
      writeSessionPermissionCheckpoint({ workspaceRoot, projectSlug: project.slug, sessionId: rootSessionId, hitlId: rootHitlId }),
      writeSessionPermissionCheckpoint({ workspaceRoot, projectSlug: project.slug, sessionId: childSessionId, hitlId: childHitlId }),
    ]);

    const response = { type: "permission_decision" as const, decision: "approve_once" as const };
    const claim = (sessionId: string, hitlId: string) => context.hitl.claim(
      { owner: { projectSlug: project.slug, ownerType: "session", ownerId: sessionId }, hitlId },
      response,
      { claimId: crypto.randomUUID(), claimedAt: new Date().toISOString(), intent: "respond", attempt: 1 },
    );
    await Promise.all([
      claim(rootSessionId, rootHitlId),
      claim(childSessionId, childHitlId),
    ]);

    const activityAtCancellation: string[] = [];
    const unsubscribeHitl = runtime.subscribeHitlEvents((event) => {
      if (event.payload.status === "cancelled") {
        activityAtCancellation.push(runtime.getSessionFamilyActivity(workspaceRoot, rootSessionId));
      }
    });
    await runtime.stopSessionFamily(workspaceRoot, rootSessionId);
    unsubscribeHitl();

    expect(activityAtCancellation).toEqual(["stopping", "stopping"]);
    expect(runtime.getSessionFamilyActivity(workspaceRoot, rootSessionId)).toBe("idle");
    for (const [sessionId, hitlId] of [[rootSessionId, rootHitlId], [childSessionId, childHitlId]] as const) {
      expect(await context.hitl.lookup({
        owner: { projectSlug: project.slug, ownerType: "session", ownerId: sessionId },
        hitlId,
      })).toMatchObject({ status: "found", record: { status: "cancelled" } });
      expect(await Bun.file(getSessionHitlCheckpointPath(workspaceRoot, sessionId)).exists()).toBe(false);
    }
    const coldSessions = new SessionStoreManager({ logger });
    expect((await coldSessions.getOrLoad(rootSessionId, workspaceRoot)).getState()).toMatchObject({
      blockedHitl: undefined,
      blockedByHitlIds: undefined,
    });
    expect((await coldSessions.getOrLoad(childSessionId, workspaceRoot)).getState()).toMatchObject({
      blockedHitl: undefined,
      blockedByHitlIds: undefined,
    });
    expect(await context.hitl.lookup({
      owner: { projectSlug: project.slug, ownerType: "session", ownerId: unrelatedSessionId },
      hitlId: unrelatedHitlId,
    })).toMatchObject({ status: "found", record: { status: "pending" } });
  });

  test("starts with mcp.servers as an empty object", async () => {
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    let resolvedConfig: ResolvedMcpConfig | undefined;
    const manager = makeFakeMcpManager({ descriptors: [], warnings: [] });

    const runtime = await createRuntime({
      configPath,
      mcpManagerFactory: (config) => {
        resolvedConfig = config;
        return manager;
      },
    });

    expect(resolvedConfig).toEqual({ servers: {} });
    expect(runtime.warnings).toEqual([]);
  });

  test("records a redacted discovery failure warning and still constructs the agent", async () => {
    const secret = "sk_test_main_secret";
    const configPath = await writeConfig(
      makeConfig({
        servers: {
          context7: {
            transport: "http",
            url: "https://mcp.example.test",
            headers: { Authorization: secret },
          },
        },
      }),
    );
    const { logger, entries } = createInMemoryLogger();
    const manager = makeFakeMcpManager(new Error(`boom ${secret}`), [secret]);

    const runtime = await createRuntime({
      configPath,
      mcpManagerFactory: () => manager,
      logger,
    });

    expect(runtime.warnings).toHaveLength(1);
    expect(entries.map((entry) => entry.event)).toContain("mcp.discovery.warning");
    expect(runtime.warnings[0].message).toContain(REDACTION_MARKER);
    expect(runtime.warnings[0].message).not.toContain(secret);
  });

  test("public server URL without auth headers is not redacted in warnings", async () => {
    const publicUrl = "https://public.example.test/mcp";
    const configPath = await writeConfig(
      makeConfig({
        servers: {
          public: { transport: "http", url: publicUrl },
        },
      }),
    );
    const manager = makeFakeMcpManager(new Error(`connection refused: ${publicUrl}`));

    const runtime = await createRuntime({
      configPath,
      mcpManagerFactory: () => manager,
    });

    expect(runtime.warnings).toHaveLength(1);
    expect(runtime.warnings[0].message).toContain(publicUrl);
    expect(runtime.warnings[0].message).not.toContain(REDACTION_MARKER);
  });

  test("records a duplicate MCP descriptor warning and still constructs the agent", async () => {
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    const duplicateBuiltin = makeMcpDescriptor("file_read");
    const manager = makeFakeMcpManager({
      descriptors: [duplicateBuiltin],
      warnings: [],
    });

    const runtime = await createRuntime({
      configPath,
      mcpManagerFactory: () => manager,
    });

    expect(runtime.toolRegistry.get("file_read")).not.toBe(duplicateBuiltin);
    expect(runtime.warnings).toEqual([
      {
        toolName: "file_read",
        message: 'Duplicate MCP tool descriptor "file_read" skipped during startup',
      },
    ]);
  });

  test("keeps builtin tools registered alongside MCP tools", async () => {
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    const mcpDescriptor = makeMcpDescriptor();
    const manager = makeFakeMcpManager({ descriptors: [mcpDescriptor], warnings: [] });

    const runtime = await createRuntime({
      configPath,
      mcpManagerFactory: () => manager,
    });

    expect(runtime.toolRegistry.get("file_read")).toBeDefined();
    expect(runtime.toolRegistry.get("grep")).toBeDefined();
    expect(runtime.toolRegistry.get("web_fetch")).toBeDefined();
    expect(runtime.toolRegistry.get(mcpDescriptor.name)).toBeDefined();
  });

  test("runs MCP tools through registry global after-hooks", async () => {
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    const mcpDescriptor = makeMcpDescriptor();
    const manager = makeFakeMcpManager({ descriptors: [mcpDescriptor], warnings: [] });

    const runtime = await createRuntime({
      configPath,
      mcpManagerFactory: () => manager,
    });
    const result = await runtime.toolRegistry.execute(
      {
        toolName: mcpDescriptor.name,
        toolCallId: "mcp-call",
        input: {},
      },
      makeContext(mcpDescriptor.name, {}),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain(REDACTION_MARKER);
    expect(result.output).not.toContain("sk_test_main_secret");
  });
});
