import { afterAll, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { GlobalSSESessionRuntimeChangedEvent } from "@archcode/protocol";
import type { ResolvedMcpConfig } from "./config/mcp";
import { redactMcpMessage, type McpDiscoveryResult, type McpManager, type McpWarning } from "./mcp/index";
import { storeManager } from "./store/store";
import { defineTool, REDACTION_MARKER, type ToolExecutionContext } from "./tools/index";
import type { AnyToolDescriptor } from "./tools/types";
import { createRuntime as createProductionRuntime } from "./runtime";
import { SessionStoreManager } from "./store/session-store-manager";
import type { SessionToolBatch } from "./store/types";
import { createTestProjectContext } from "./tools/test-project-context";
import { createInMemoryLogger, silentLogger } from "./logger";
import { ServerConfigService, resolveServerConfigPath } from "./config";

const tmpRoots: string[] = [];
afterAll(() => { for (const root of tmpRoots) rmSync(root, { recursive: true, force: true }); });

function makeProviderConfig() {
  return { local: { npm: "@ai-sdk/openai-compatible", name: "Local LLM", options: { baseURL: "http://localhost:8090/v1", apiKey: "test-key" }, models: { "test-model": { name: "Test Model", limit: { context: 128000, output: 8192 }, modalities: { input: ["text"], output: ["text"] } } } } };
}
async function makeTempRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "archcode-main-")); tmpRoots.push(root); return root; }
async function writeConfig(config: Record<string, unknown>): Promise<ServerConfigService> { const root = await makeTempRoot(); const path = resolveServerConfigPath(root); await mkdir(join(root, ".archcode"), { recursive: true }); await Bun.write(path, JSON.stringify(config)); return new ServerConfigService({ homeDir: root }); }
function makeConfig(mcp?: Record<string, unknown>): Record<string, unknown> {
  const config = { provider: makeProviderConfig(), agents: Object.fromEntries(["engineer", "goal_lead", "plan", "build", "reviewer", "explore", "librarian"].map((name) => [name, { model: "local:test-model" }])) };
  return mcp === undefined ? config : { ...config, mcp };
}
function makeMcpDescriptor(name = "mcp__context7__lookup"): AnyToolDescriptor { return defineTool({ name, description: "Fake MCP lookup tool", inputSchema: z.object({}).catchall(z.unknown()), traits: { readOnly: true, destructive: false, concurrencySafe: true }, execute: async () => "mcp output with sk_test_main_secret" }); }
function makeFakeMcpManager(result: McpDiscoveryResult | Error, secrets: readonly string[] = []): McpManager {
  return { discover: mock(async () => { if (result instanceof Error) throw result; return result; }), closeAll: mock(async () => []), getStatus: mock(() => new Map()), onStatusChange: mock(() => () => {}), startBackgroundDiscovery: mock((onDescriptors: (d: AnyToolDescriptor[]) => void, onWarning: (w: McpWarning) => void) => { if (result instanceof Error) { onWarning({ message: redactMcpMessage(`Failed to discover MCP tools during startup: ${result.message}`, secrets) }); return; } for (const warning of result.warnings) onWarning(warning); if (result.descriptors.length) onDescriptors(result.descriptors); }) } as unknown as McpManager;
}
function makeContext(toolName: string, input: unknown): ToolExecutionContext { const workspaceRoot = import.meta.dir; return { store: storeManager.create(`main-test-${crypto.randomUUID()}`, workspaceRoot, { agentName: "engineer" }), storeManager, toolName, toolCallId: `${toolName}-call`, input, step: 0, abort: new AbortController().signal, startedAt: 0, allowedTools: new Set([toolName]), cwd: workspaceRoot, projectContext: createTestProjectContext(workspaceRoot) }; }
async function createRuntime(options: Parameters<typeof createProductionRuntime>[0] = {}) { return createProductionRuntime({ ...options, projectRegistryHomeDir: options.projectRegistryHomeDir ?? await makeTempRoot() }); }

describe("createRuntime", () => {
  test("constructs runtime without booting server concerns", async () => { const runtime = await createRuntime({ configService: await writeConfig(makeConfig({ servers: {} })), mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }) }); expect(runtime.toolRegistry).toBeDefined(); expect(runtime.startSessionExecution).toBeDefined(); });
  test("keeps runtime providers on startup snapshot after settings save", async () => { const configService = await writeConfig(makeConfig({ servers: {} })); const runtime = await createRuntime({ configService, mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }) }); const snapshot = await runtime.configService.getSnapshot(); const update = structuredClone(snapshot.config) as any; update.provider.local.options.apiKey = { action: "preserve" }; update.provider.local.models["new-model"] = { name: "New", limit: { context: 128000, output: 8192 }, modalities: { input: ["text"], output: ["text"] } }; const saved = await runtime.configService.save({ expectedRevision: snapshot.revision, config: update }); expect(saved.restartRequired).toBe(true); expect(runtime.providerRegistry.modelIds).toEqual(["local:test-model"]); });
  test("registers MCP descriptors before agent runs", async () => { const descriptor = makeMcpDescriptor(); const runtime = await createRuntime({ configService: await writeConfig(makeConfig({ servers: {} })), mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [descriptor], warnings: [] }) }); expect(runtime.toolRegistry.get(descriptor.name)).toBe(descriptor); });
  test("starts with no MCP config", async () => { let resolved: ResolvedMcpConfig | undefined; const runtime = await createRuntime({ configService: await writeConfig(makeConfig()), mcpManagerFactory: (config) => { resolved = config; return makeFakeMcpManager({ descriptors: [], warnings: [] }); } }); expect(resolved).toEqual({ servers: {} }); expect(runtime.warnings).toEqual([]); });
  test("exposes project registry and shared context resolver", async () => { const runtime = await createRuntime({ configService: await writeConfig(makeConfig()), mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }) }); expect(runtime.projectRegistry).toBeDefined(); expect(runtime.contextResolver).toBeDefined(); });
  test("emits runtime snapshot without idle families", async () => { const workspaceRoot = await makeTempRoot(); const runtime = await createRuntime({ configService: await writeConfig(makeConfig()), mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }) }); const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Runtime snapshot" }); const session = await runtime.createSession(workspaceRoot, { agentName: "engineer" }); const changes: GlobalSSESessionRuntimeChangedEvent[] = []; const unsubscribe = runtime.subscribeSessionRuntimeChanges((event) => changes.push(event)); const events = await runtime.listSessionRuntimeEvents(); expect(events[0]).toMatchObject({ type: "session.runtime.snapshot", projectSlugs: [project.slug], families: [] }); await expect(runtime.stopSessionFamily(workspaceRoot, session.sessionId)).resolves.toBeUndefined(); expect(changes.map(({ activity }) => activity)).toEqual(["stopping", "idle"]); unsubscribe(); });
  test("redacts MCP discovery failures", async () => { const secret = "sk_test_main_secret"; const configService = await writeConfig(makeConfig({ servers: { private_docs: { url: "https://mcp.example.test", headers: { Authorization: secret } } } })); const { logger, entries } = createInMemoryLogger(); const runtime = await createRuntime({ configService, mcpManagerFactory: () => makeFakeMcpManager(new Error(`boom ${secret}`), [secret]), logger }); expect(runtime.warnings).toHaveLength(1); expect(entries.map((entry) => entry.event)).toContain("mcp.discovery.warning"); expect(runtime.warnings[0].message).toContain(REDACTION_MARKER); expect(runtime.warnings[0].message).not.toContain(secret); });
  test("warns on duplicate MCP descriptors while retaining builtins", async () => { const runtime = await createRuntime({ configService: await writeConfig(makeConfig({ servers: {} })), mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [makeMcpDescriptor("file_read")], warnings: [] }) }); expect(runtime.toolRegistry.get("file_read")).toBeDefined(); expect(runtime.warnings[0]?.toolName).toBe("file_read"); });
  test("runs MCP tools through global after hooks", async () => { const descriptor = makeMcpDescriptor(); const runtime = await createRuntime({ configService: await writeConfig(makeConfig({ servers: {} })), mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [descriptor], warnings: [] }) }); const result = await runtime.toolRegistry.execute({ toolName: descriptor.name, toolCallId: "mcp-call", input: {} }, makeContext(descriptor.name, {})); expect(result.isError).toBe(false); expect(result.output).toContain(REDACTION_MARKER); expect(result.output).not.toContain("sk_test_main_secret"); });

  test("reconciles an answered Session HITL to its exact blocked call after restart", async () => {
    const workspaceRoot = await makeTempRoot();
    const registryHome = await makeTempRoot();
    const runtime1 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      projectRegistryHomeDir: registryHome,
      mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }),
    });
    const project = await runtime1.projectRegistry.add({ workspaceRoot, name: "HITL restart" });
    const session = await runtime1.createSession(workspaceRoot, { agentName: "engineer" });
    const context = await runtime1.contextResolver.resolve(workspaceRoot);
    const first = (await context.hitl.create({
      requestKey: `session:${session.sessionId}:batch:batch-1:tool:question-1`,
      owner: { type: "session", id: session.sessionId },
      source: { type: "ask_user", toolCallId: "question-1" },
      displayPayload: { title: "First question", redacted: true },
    })).record;
    const second = (await context.hitl.create({
      requestKey: `session:${session.sessionId}:batch:batch-1:tool:question-2`,
      owner: { type: "session", id: session.sessionId },
      source: { type: "ask_user", toolCallId: "question-2" },
      displayPayload: { title: "Second question", redacted: true },
    })).record;
    const now = new Date().toISOString();
    const questionInput = {
      questions: [{
        question: "Continue?",
        header: "Continue",
        options: [{ label: "Yes", description: "Continue" }],
      }],
    };
    const batch: SessionToolBatch = {
      batchId: "batch-1",
      executionId: "execution-1",
      step: 0,
      agentName: "engineer",
      allowedTools: ["ask_user"],
      agentSkills: [],
      partitions: [{ type: "parallel", callIds: ["question-1", "question-2"] }],
      calls: [first, second].map((record, ordinal) => ({
        ordinal,
        partitionIndex: 0,
        toolCallId: record.source.type === "ask_user" ? record.source.toolCallId : "unreachable",
        toolName: "ask_user",
        input: questionInput,
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        state: "blocked" as const,
        attempt: 1,
        blocker: {
          requestKey: record.requestKey,
          hitlId: record.hitlId,
          source: record.source as Extract<typeof record.source, { type: "ask_user" }>,
          displayPayload: record.displayPayload,
        },
      })),
      createdAt: now,
      updatedAt: now,
    };
    const seedStoreManager = new SessionStoreManager({ logger: silentLogger });
    await seedStoreManager.getOrLoad(session.sessionId, workspaceRoot);
    await seedStoreManager.updateToolBatches(session.sessionId, workspaceRoot, () => [batch]);
    await context.hitl.respond(first.hitlId, { type: "question_answer", answers: ["Yes"] });

    const runtime2 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      projectRegistryHomeDir: registryHome,
      mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }),
    });

    const recovered = await runtime2.getSessionFile(workspaceRoot, session.sessionId);
    const recoveredCalls = recovered.toolBatches[0]?.calls;
    expect(recoveredCalls?.[0]).toMatchObject({
      toolCallId: "question-1",
      state: "completed",
      blocker: { hitlId: first.hitlId },
    });
    expect(typeof recoveredCalls?.[0]?.blocker?.responseAppliedAt).toBe("string");
    expect(recoveredCalls?.[1]).toMatchObject({
      toolCallId: "question-2",
      state: "blocked",
      blocker: { hitlId: second.hitlId },
    });
    expect(recoveredCalls?.[0]?.result?.output).toContain("Yes");
    expect((await (await runtime2.contextResolver.resolve(workspaceRoot)).hitl.list()).find((record) => record.hitlId === first.hitlId)?.status).toBe("resolved");
    await runtime2.abortAllSessionExecutions();
  });

  test("coalesces concurrent identical HITL responses into one delivery", async () => {
    const workspaceRoot = await makeTempRoot();
    const registryHome = await makeTempRoot();
    const runtime1 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      projectRegistryHomeDir: registryHome,
      mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }),
    });
    const project = await runtime1.projectRegistry.add({ workspaceRoot, name: "Concurrent HITL" });
    const session = await runtime1.createSession(workspaceRoot, { agentName: "engineer" });
    const context1 = await runtime1.contextResolver.resolve(workspaceRoot);
    const record = (await context1.hitl.create({
      requestKey: `session:${session.sessionId}:batch:batch-concurrent:tool:question-concurrent`,
      owner: { type: "session", id: session.sessionId },
      source: { type: "ask_user", toolCallId: "question-concurrent" },
      displayPayload: {
        title: "Concurrent question",
        questions: [{ question: "Continue?", header: "Continue", custom: true }],
        redacted: true,
      },
    })).record;
    const now = new Date().toISOString();
    const batch: SessionToolBatch = {
      batchId: "batch-concurrent",
      executionId: "execution-concurrent",
      step: 0,
      agentName: "engineer",
      allowedTools: ["ask_user"],
      agentSkills: [],
      partitions: [{ type: "serial", callIds: ["question-concurrent"] }],
      calls: [{
        ordinal: 0,
        partitionIndex: 0,
        toolCallId: "question-concurrent",
        toolName: "ask_user",
        input: { questions: [{ question: "Continue?", header: "Continue", custom: true }] },
        traits: { readOnly: true, destructive: false, concurrencySafe: false },
        state: "blocked",
        attempt: 1,
        blocker: {
          requestKey: record.requestKey,
          hitlId: record.hitlId,
          source: { type: "ask_user", toolCallId: "question-concurrent" },
          displayPayload: record.displayPayload,
        },
      }],
      createdAt: now,
      updatedAt: now,
    };
    const seedStoreManager = new SessionStoreManager({ logger: silentLogger });
    await seedStoreManager.getOrLoad(session.sessionId, workspaceRoot);
    await seedStoreManager.updateToolBatches(session.sessionId, workspaceRoot, () => [batch]);

    const runtime2 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      projectRegistryHomeDir: registryHome,
      mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }),
    });

    const responses = await Promise.all(Array.from({ length: 4 }, () => runtime2.respondToHitl({
      slug: project.slug,
      workspaceRoot,
      hitlId: record.hitlId,
      response: { type: "question_answer", answers: ["Yes"] },
    })));

    expect(responses.map(({ status }) => status)).toEqual(["resolved", "resolved", "resolved", "resolved"]);
    const context2 = await runtime2.contextResolver.resolve(workspaceRoot);
    const resolved = (await context2.hitl.list()).find(({ hitlId }) => hitlId === record.hitlId);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.delivery).toBeUndefined();
    await runtime2.abortAllSessionExecutions();
  });
});
