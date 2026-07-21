import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type {
  GlobalSSESessionRuntimeChangedEvent,
  RequestedModelSelection,
  ServerConfigUpdate,
} from "@archcode/protocol";
import type { ResolvedMcpConfig } from "./config/mcp";
import type { McpDiscoveryResult, McpManager, McpWarning } from "./mcp/index";
import { storeManager } from "./store/store";
import { defineTool, type ToolExecutionContext } from "./tools/index";
import { REDACTION_MARKER, SecretRedactionPolicy } from "./security";
import { expectSettledResult } from "./tools/test-results";
import type { AnyToolDescriptor } from "./tools/types";
import { createRuntime as createProductionRuntime } from "./runtime";
import { SessionStoreManager } from "./store/session-store-manager";
import type { SessionToolBatch } from "./store/types";
import { createTestProjectContext } from "./tools/test-project-context";
import { createInMemoryLogger, silentLogger } from "./logger";
import { ServerConfigService, resolveServerConfigPath } from "./config";
import { setLlmAdapterForTest } from "./llm";
import { getLspClientPool } from "./lsp/client-pool";
import { SessionGoalService } from "./session-goal";

const tmpRoots: string[] = [];
const requestedModelSelection: RequestedModelSelection = {
  mode: "profile_default",
  selection: { model: "local:test-model" },
};
afterAll(() => { for (const root of tmpRoots) rmSync(root, { recursive: true, force: true }); });
afterEach(() => setLlmAdapterForTest(undefined));

function makeProviderConfig() {
  return { local: { npm: "@ai-sdk/openai-compatible", name: "Local LLM", options: { baseURL: "http://localhost:8090/v1", apiKey: "test-key" }, models: { "test-model": { name: "Test Model", limit: { context: 128000, output: 8192 }, modalities: { input: ["text"], output: ["text"] } } } } };
}
async function makeTempRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "archcode-main-")); tmpRoots.push(root); return root; }
async function writeConfig(config: Record<string, unknown>): Promise<ServerConfigService> { const root = await makeTempRoot(); const path = resolveServerConfigPath(root); await mkdir(join(root, ".archcode"), { recursive: true }); await Bun.write(path, JSON.stringify(config)); return new ServerConfigService({ homeDir: root }); }
function makeConfig(mcp?: Record<string, unknown>): Record<string, unknown> {
  const config = { provider: makeProviderConfig(), profiles: Object.fromEntries(["principal", "deep", "fast"].map((name) => [name, { model: "local:test-model" }])) };
  return mcp === undefined ? config : { ...config, mcp };
}
function makeMcpDescriptor(name = "mcp__context7__lookup"): AnyToolDescriptor { return defineTool({ name, description: "Fake MCP lookup tool", inputSchema: z.object({}).catchall(z.unknown()), outputPolicy: { kind: "artifact", previewDirection: "head-tail" }, traits: { readOnly: true, destructive: false, concurrencySafe: true }, execute: async () => ({ isError: false, draft: { kind: "text", text: "mcp output with sk_test_main_secret" } }) }); }
function makeFakeMcpManager(result: McpDiscoveryResult | Error, secrets: readonly string[] = []): McpManager {
  const policy = new SecretRedactionPolicy(secrets);
  return { discover: mock(async () => { if (result instanceof Error) throw result; return result; }), closeAll: mock(async () => []), getStatus: mock(() => new Map()), onStatusChange: mock(() => () => {}), startBackgroundDiscovery: mock((onDescriptors: (d: AnyToolDescriptor[]) => void, onWarning: (w: McpWarning) => void) => { if (result instanceof Error) { onWarning({ message: policy.redactString(`Failed to discover MCP tools during startup: ${result.message}`) }); return; } for (const warning of result.warnings) onWarning(warning); if (result.descriptors.length) onDescriptors(result.descriptors); }) } as unknown as McpManager;
}
function makeContext(toolName: string, input: unknown): ToolExecutionContext { const workspaceRoot = import.meta.dir; return { store: storeManager.create(`main-test-${crypto.randomUUID()}`, workspaceRoot, { agentName: "lead" }), storeManager, toolName, toolCallId: `${toolName}-call`, input, step: 0, abort: new AbortController().signal, startedAt: 0, allowedTools: new Set([toolName]), cwd: workspaceRoot, projectContext: createTestProjectContext(workspaceRoot) }; }
async function createRuntime(options: Parameters<typeof createProductionRuntime>[0] = {}) { return createProductionRuntime({ ...options, projectRegistryHomeDir: options.projectRegistryHomeDir ?? await makeTempRoot() }); }
async function waitFor(assertion: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await assertion()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime state");
    await Bun.sleep(5);
  }
}

function createGoalActivationStream(
  objective = "Complete the requested migration and verify every relevant test passes.",
): unknown {
  const input = { objective };
  return {
    fullStream: (async function* () {
      yield { type: "tool-input-start", id: "create-goal", toolName: "create_goal" };
      yield { type: "tool-call", toolCallId: "create-goal", toolName: "create_goal", input };
    })(),
    finishReason: Promise.resolve("tool-calls"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
    text: Promise.resolve("I will keep working until it is verified."),
    toolCalls: Promise.resolve([{ toolCallId: "create-goal", toolName: "create_goal", input }]),
  };
}

function createAbortableStream(abortSignal: AbortSignal): unknown {
  return {
    fullStream: (async function* () {
      while (!abortSignal.aborted) await Bun.sleep(5);
    })(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([]),
  };
}

function createStoppedStream(): unknown {
  return {
    fullStream: (async function* () {})(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([]),
  };
}

describe("createRuntime", () => {
  test("constructs runtime without booting server concerns", async () => { const runtime = await createRuntime({ configService: await writeConfig(makeConfig({ servers: {} })), mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }) }); expect(runtime.toolRegistry).toBeDefined(); expect(runtime.acceptSessionMessage).toBeDefined(); });
  test("injects the runtime log safety boundary into the default LSP pool", async () => {
    const literal = "runtime-secret-literal-123456";
    const workspaceRoot = "/private/tmp/archcode-runtime-log-workspace";
    const { logger, entries } = createInMemoryLogger();
    await createRuntime({
      logger,
      externalSecretLiterals: [literal],
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }),
    });

    await expect(getLspClientPool().acquire(
      { workspaceRoot, serverId: literal },
      { command: "unused" },
    )).rejects.toThrow("Unknown LSP server");

    const entry = entries.find((candidate) => candidate.event === "lsp.pool.acquire.failed");
    expect(entry).toMatchObject({
      event: "lsp.pool.acquire.failed",
      context: { serverId: REDACTION_MARKER },
      meta: { error: { name: "LspInstallerError", code: "RUNTIME_LOG_FAILURE" } },
    });
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(literal);
    expect(serialized).not.toContain(workspaceRoot);
  });
  test("accepts ordinary root Session messages through the durable queue boundary", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Queued input" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead", title: "Queued input" });
    expect(session.nextModelSelection).toMatchObject({
      requested: requestedModelSelection,
      resolved: {
        selection: requestedModelSelection.selection,
        modelDisplayName: "Test Model",
        resolution: "profile_default",
      },
    });
    const clientRequestId = crypto.randomUUID();
    installTestLlmAdapter();
    try {
      const accepted = await runtime.acceptSessionMessage({
        slug: project.slug,
        workspaceRoot,
        sessionId: session.sessionId,
        text: "Inspect the project",
        clientRequestId,
        source: "user",
        requestedModelSelection,
      });
      expect(accepted).toMatchObject({ clientRequestId });
      expect(["pending", "canonical"]).toContain(accepted.status);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await runtime.getSessionFile(workspaceRoot, session.sessionId);
        const receipt = current.inputRequestReceipts.find((candidate) => candidate.clientRequestId === clientRequestId);
        if (receipt?.status === "canonical" && runtime.getSessionFamilyActivity(workspaceRoot, session.sessionId) === "idle") break;
        await Bun.sleep(5);
      }
      expect((await runtime.getSessionFile(workspaceRoot, session.sessionId)).inputRequestReceipts)
        .toContainEqual(expect.objectContaining({ clientRequestId, status: "canonical" }));
    } finally {
      await runtime.abortAllSessionExecutions();
      setLlmAdapterForTest(undefined);
    }
  });
  test("integrates Analyst and Build results through the ordinary Lead delegation path", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Lead collaboration" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead", title: "Lead collaboration" });
    const projectContext = await runtime.contextResolver.resolve(workspaceRoot);
    expect(await projectContext.todos.state.findByDiscussionSessionId(session.sessionId)).toBeUndefined();
    const overriddenModel = await runtime.patchSessionModelSelection({
      workspaceRoot,
      sessionId: session.sessionId,
      expectedRevision: 0,
      requestedModelSelection: {
        mode: "session_override",
        selection: { model: "local:test-model" },
      },
    });
    expect(overriddenModel.modelSelection).toEqual({
      revision: 1,
      override: { model: "local:test-model" },
    });
    expect(overriddenModel.nextModelSelection).toMatchObject({
      requested: { mode: "session_override" },
      resolved: { resolution: "session_override" },
    });
    const clearedModel = await runtime.patchSessionModelSelection({
      workspaceRoot,
      sessionId: session.sessionId,
      expectedRevision: 1,
      requestedModelSelection,
    });
    expect(clearedModel.modelSelection).toEqual({ revision: 2 });
    expect(clearedModel.nextModelSelection).toMatchObject({
      requested: { mode: "profile_default" },
      resolved: { resolution: "profile_default" },
    });
    let rootCalls = 0;
    let integratedMessages = "";
    const seenToolSets: string[][] = [];
    const textStream = (text: string) => ({
      fullStream: (async function* () { yield { type: "text-delta", text }; })(),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ totalTokens: 1 }),
      text: Promise.resolve(text),
      toolCalls: Promise.resolve([]),
    });
    const delegations = [
      {
        toolCallId: "delegate-analysis",
        toolName: "delegate",
        input: {
          agent_type: "analyst",
          profile: "deep",
          title: "Analyze the change",
          objective: "Identify the architecture risks and required evidence.",
          skills: ["analyze-work"],
          background: false,
        },
      },
      {
        toolCallId: "delegate-build",
        toolName: "delegate",
        input: {
          agent_type: "build",
          profile: "deep",
          title: "Implement the change",
          objective: "Implement the bounded change and report verification.",
          skills: ["safe-refactor"],
          background: false,
        },
      },
    ] as const;
    setLlmAdapterForTest({
      streamText: mock((options: { tools?: Record<string, unknown>; messages?: unknown[] }) => {
        const tools = Object.keys(options.tools ?? {});
        seenToolSets.push(tools);
        if (tools.includes("create_goal")) {
          rootCalls += 1;
          if (rootCalls === 1) {
            return {
              fullStream: (async function* () {
                for (const call of delegations) yield { type: "tool-call", ...call };
              })(),
              finishReason: Promise.resolve("tool-calls"),
              usage: Promise.resolve({ totalTokens: 1 }),
              text: Promise.resolve(""),
              toolCalls: Promise.resolve([...delegations]),
            } as never;
          }
          integratedMessages = JSON.stringify(options.messages ?? []);
          return textStream("Integrated the Analyst and Build results.") as never;
        }
        if (tools.includes("file_write")) return textStream("Build verification complete.") as never;
        return textStream("Analysis evidence complete.") as never;
      }) as never,
      generateText: mock(async () => ({ text: "Lead collaboration", toolCalls: [] })) as never,
    });

    try {
      const clientRequestId = crypto.randomUUID();
      await runtime.acceptSessionMessage({
        slug: project.slug,
        workspaceRoot,
        sessionId: session.sessionId,
        text: "Analyze and implement the requested change.",
        clientRequestId,
        source: "user",
        requestedModelSelection,
      });
      await waitFor(async () => {
        const current = await runtime.getSessionFile(workspaceRoot, session.sessionId);
        const canonical = current.inputRequestReceipts.some((receipt) => (
          receipt.clientRequestId === clientRequestId && receipt.status === "canonical"
        ));
        return canonical && runtime.getSessionFamilyActivity(workspaceRoot, session.sessionId) === "idle";
      }, 5_000);

      const tree = await runtime.listSessionTree(workspaceRoot, session.sessionId);
      expect(seenToolSets).toContainEqual(expect.arrayContaining(["create_goal", "delegate"]));
      expect(integratedMessages).toContain("Analysis evidence complete.");
      expect(integratedMessages).toContain("Build verification complete.");
      expect(tree.diagnostics).toEqual([]);
      expect(tree.root.children.map(({ session: child }) => ({
        agentName: child.agentName,
        profile: child.profile,
        skills: child.activeSkillNames,
        title: child.title,
      }))).toEqual([
        { agentName: "analyst", profile: "deep", skills: ["analyze-work"], title: "Analyze the change" },
        { agentName: "build", profile: "deep", skills: ["safe-refactor"], title: "Implement the change" },
      ]);
      for (const child of tree.root.children) {
        expect((await runtime.getSessionFile(workspaceRoot, child.session.sessionId)).executions.at(-1)?.status)
          .toBe("completed");
      }
      expect((await runtime.getSessionFile(workspaceRoot, session.sessionId)).executions.at(-1)?.status)
        .toBe("completed");
    } finally {
      await runtime.abortAllSessionExecutions();
      await runtime.shutdown();
    }
  });
  test("does not execute a handled command twice when the same request is retried", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Command retry" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead" });
    const clientRequestId = crypto.randomUUID();
    const input = {
      slug: project.slug,
      workspaceRoot,
      sessionId: session.sessionId,
      text: "/unknown-command",
      clientRequestId,
      source: "user" as const,
      requestedModelSelection,
    };

    await expect(runtime.acceptSessionMessage(input)).resolves.toEqual({ clientRequestId, status: "command" });
    await expect(runtime.acceptSessionMessage(input)).resolves.toEqual({ clientRequestId, status: "command" });

    const file = await runtime.getSessionFile(workspaceRoot, session.sessionId);
    expect(file.inputRequestReceipts).toEqual([
      expect.objectContaining({ kind: "command", clientRequestId, status: "completed" }),
    ]);
    expect(file.messages.flatMap((message) => message.parts)
      .filter((part) => part.type === "system-notice" && part.notice.includes("Unknown command")))
      .toHaveLength(1);
  });
  test("coalesces concurrent retries before the command receipt is durable", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Concurrent command retry" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead" });
    const clientRequestId = crypto.randomUUID();
    const input = {
      slug: project.slug,
      workspaceRoot,
      sessionId: session.sessionId,
      text: "/unknown-command",
      clientRequestId,
      source: "user" as const,
      requestedModelSelection,
    };

    await expect(Promise.all([
      runtime.acceptSessionMessage(input),
      runtime.acceptSessionMessage(input),
    ])).resolves.toEqual([
      { clientRequestId, status: "command" },
      { clientRequestId, status: "command" },
    ]);

    const file = await runtime.getSessionFile(workspaceRoot, session.sessionId);
    expect(file.inputRequestReceipts).toEqual([
      expect.objectContaining({ kind: "command", clientRequestId, status: "completed" }),
    ]);
    expect(file.messages.flatMap((message) => message.parts)
      .filter((part) => part.type === "system-notice" && part.notice.includes("Unknown command")))
      .toHaveLength(1);
  });
  test("publishes provider and model settings to the live runtime", async () => {
    const configService = await writeConfig(makeConfig({ servers: {} }));
    const runtime = await createRuntime({
      configService,
      mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }),
    });
    const snapshot = await runtime.configService.getSnapshot();
    const update = structuredClone(snapshot.config) as unknown as ServerConfigUpdate;
    update.provider.local.options.apiKey = { action: "preserve" };
    update.provider.local.models["new-model"] = {
      name: "New",
      limit: { context: 128000, output: 8192 },
      modalities: { input: ["text"], output: ["text"] },
    };

    const saved = await runtime.configService.save({
      expectedRevision: snapshot.revision,
      config: update,
    });

    expect(saved.restartRequiredSections).toEqual([]);
    expect(saved.modelRuntimeRevision).toBe(saved.revision);
    expect(runtime.modelRuntime.current.revision).toBe(saved.revision);
    expect(runtime.modelRuntime.current.tryResolveSelection({ model: "local:new-model" }))
      .toBeDefined();
  });
  test("registers MCP descriptors before agent runs", async () => { const descriptor = makeMcpDescriptor(); const runtime = await createRuntime({ configService: await writeConfig(makeConfig({ servers: {} })), mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [descriptor], warnings: [] }) }); expect(runtime.toolRegistry.get(descriptor.name)).toBe(descriptor); });
  test("starts with no MCP config", async () => { let resolved: ResolvedMcpConfig | undefined; const runtime = await createRuntime({ configService: await writeConfig(makeConfig()), mcpManagerFactory: (config) => { resolved = config; return makeFakeMcpManager({ descriptors: [], warnings: [] }); } }); expect(resolved).toEqual({ servers: {} }); expect(runtime.warnings).toEqual([]); });
  test("exposes project registry and shared context resolver", async () => { const runtime = await createRuntime({ configService: await writeConfig(makeConfig()), mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }) }); expect(runtime.projectRegistry).toBeDefined(); expect(runtime.contextResolver).toBeDefined(); });
  test("emits runtime snapshot without idle families", async () => { const workspaceRoot = await makeTempRoot(); const runtime = await createRuntime({ configService: await writeConfig(makeConfig()), mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }) }); const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Runtime snapshot" }); const session = await runtime.createSession(workspaceRoot, { agentName: "lead" }); const changes: GlobalSSESessionRuntimeChangedEvent[] = []; const unsubscribe = runtime.subscribeSessionRuntimeChanges((event) => changes.push(event)); const events = await runtime.listSessionRuntimeEvents(); expect(events[0]).toMatchObject({ type: "session.runtime.snapshot", projectSlugs: [project.slug], families: [] }); await expect(runtime.stopSessionFamily(workspaceRoot, session.sessionId)).resolves.toBeUndefined(); expect(changes.map(({ activity }) => activity)).toEqual(["stopping", "idle"]); unsubscribe(); });
  test("redacts MCP discovery failures", async () => { const secret = "sk_test_main_secret"; const configService = await writeConfig(makeConfig({ servers: { private_docs: { url: "https://mcp.example.test", headers: { Authorization: secret } } } })); const { logger, entries } = createInMemoryLogger(); const runtime = await createRuntime({ configService, mcpManagerFactory: () => makeFakeMcpManager(new Error(`boom ${secret}`), [secret]), logger }); expect(runtime.warnings).toHaveLength(1); expect(entries.map((entry) => entry.event)).toContain("mcp.discovery.warning"); expect(runtime.warnings[0].message).toContain(REDACTION_MARKER); expect(runtime.warnings[0].message).not.toContain(secret); });
  test("warns on duplicate MCP descriptors while retaining builtins", async () => { const runtime = await createRuntime({ configService: await writeConfig(makeConfig({ servers: {} })), mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [makeMcpDescriptor("file_read")], warnings: [] }) }); expect(runtime.toolRegistry.get("file_read")).toBeDefined(); expect(runtime.warnings[0]?.toolName).toBe("file_read"); });
  test("runs MCP tools through global after hooks", async () => { const descriptor = makeMcpDescriptor(); const runtime = await createRuntime({ configService: await writeConfig(makeConfig({ servers: {} })), mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [descriptor], warnings: [] }) }); const result = expectSettledResult(await runtime.toolRegistry.execute({ toolName: descriptor.name, toolCallId: "mcp-call", input: {} }, makeContext(descriptor.name, {}))); expect(result.isError).toBe(false); expect(result.output.preview).toContain(REDACTION_MARKER); expect(result.output.preview).not.toContain("sk_test_main_secret"); });

  test("redacts HITL delivery failures before logs and durable delivery metadata", async () => {
    const secret = "hitl-delivery-secret-123456";
    const workspaceRoot = await makeTempRoot();
    const { logger, entries } = createInMemoryLogger();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      externalSecretLiterals: [secret],
      logger,
      mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "HITL delivery failure" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead" });
    const context = await runtime.contextResolver.resolve(workspaceRoot);
    const record = (await context.hitl.create({
      hitlId: secret,
      requestKey: `tool:${"a".repeat(64)}`,
      owner: { type: "session", id: session.sessionId },
      source: { type: "tool_permission", toolCallId: "missing-call", toolName: "bash" },
      displayPayload: { title: "Approve Bash", redacted: true },
      persistentApprovalEligible: false,
    })).record;

    const response = await runtime.respondToHitl({
      slug: project.slug,
      workspaceRoot,
      hitlId: record.hitlId,
      response: { type: "permission_decision", decision: "approve_once" },
    });
    expect(response.status).toBe("answered");
    const failed = (await context.hitl.list()).find(({ hitlId }) => hitlId === record.hitlId);
    expect(failed?.delivery?.error).toContain(REDACTION_MARKER);
    expect(failed?.delivery?.error).not.toContain(secret);
    expect(new TextEncoder().encode(failed?.delivery?.error ?? "").byteLength).toBeLessThanOrEqual(2 * 1024);

    const deliveryLogs = entries.filter(({ event }) => event === "hitl.delivery.failed");
    expect(deliveryLogs).toHaveLength(3);
    const serialized = JSON.stringify(deliveryLogs);
    expect(serialized).toContain(REDACTION_MARKER);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("stack");
    expect(deliveryLogs.every((entry) => entry.error === undefined)).toBe(true);
    expect(deliveryLogs.every((entry) => typeof entry.meta?.failure === "object")).toBe(true);
  });

  test("recovers one persisted active Session Goal through the public Runtime boundary", async () => {
    const workspaceRoot = await makeTempRoot();
    const registryHome = await makeTempRoot();
    let firstRuntimeStreams = 0;
    setLlmAdapterForTest({
      streamText: mock(() => {
        firstRuntimeStreams += 1;
        return firstRuntimeStreams === 1
          ? createGoalActivationStream("Keep working through the authentication migration until every test passes.")
          : createStoppedStream();
      }) as never,
      generateText: mock(async () => ({
        text: "",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
      })) as never,
    });
    const runtime1 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      projectRegistryHomeDir: registryHome,
      mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }),
    });
    const project = await runtime1.projectRegistry.add({ workspaceRoot, name: "Goal restart" });
    const session = await runtime1.createSession(workspaceRoot, { agentName: "lead" });

    await runtime1.acceptSessionMessage({
      slug: project.slug,
      workspaceRoot,
      sessionId: session.sessionId,
      text: "Keep working through the authentication migration until every test passes.",
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection,
    });
    await waitFor(async () => (await runtime1.getSessionFile(workspaceRoot, session.sessionId)).goal?.status === "active");
    // Persist a quiescent Goal before disposing Runtime 1. This prevents its
    // ordinary idle listener from starting a new turn during shutdown, while
    // still proving that activation itself came through create_goal execution.
    await runtime1.updateSessionGoalControl({ workspaceRoot, sessionId: session.sessionId, action: "pause" });
    await waitFor(() => runtime1.getSessionFamilyActivity(workspaceRoot, session.sessionId) === "idle");
    await runtime1.shutdown();
    const restartGoals = new SessionGoalService(new SessionStoreManager({ logger: silentLogger }));
    await restartGoals.resume({ workspaceRoot, sessionId: session.sessionId, authority: { kind: "user_control" } });

    let recoveredContinuations = 0;
    setLlmAdapterForTest({
      streamText: mock((options: { abortSignal: AbortSignal }) => {
        recoveredContinuations += 1;
        return createAbortableStream(options.abortSignal);
      }) as never,
      generateText: mock(async () => ({
        text: "",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
      })) as never,
    });
    const runtime2 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      projectRegistryHomeDir: registryHome,
      mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }),
    });

    await runtime2.recoverSessionContinuations();
    await waitFor(() => recoveredContinuations === 1);
    await Bun.sleep(25);
    expect(recoveredContinuations).toBe(1);
    expect(runtime2.getSessionFamilyActivity(workspaceRoot, session.sessionId)).toBe("running");
    await runtime2.updateSessionGoalControl({ workspaceRoot, sessionId: session.sessionId, action: "pause" });
    await runtime2.shutdown();
  });

  test("continues an active Goal after a completed root Execution without a workflow state machine", async () => {
    const workspaceRoot = await makeTempRoot();
    const registryHome = await makeTempRoot();
    let streams = 0;
    setLlmAdapterForTest({
      streamText: mock((options: { abortSignal: AbortSignal }) => {
        streams += 1;
        if (streams === 1) return createGoalActivationStream("Keep working until the migration is complete.");
        if (streams === 2) return createStoppedStream();
        return createAbortableStream(options.abortSignal);
      }) as never,
      generateText: mock(async () => ({ text: "", toolCalls: [] })) as never,
    });
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      projectRegistryHomeDir: registryHome,
      mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Goal continuation" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead" });

    await runtime.acceptSessionMessage({
      slug: project.slug,
      workspaceRoot,
      sessionId: session.sessionId,
      text: "Keep working until the migration is complete.",
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection,
    });

    await waitFor(() => streams >= 3);
    await waitFor(() => runtime.getSessionFamilyActivity(workspaceRoot, session.sessionId) === "running");
    const file = await runtime.getSessionFile(workspaceRoot, session.sessionId);
    expect(file.goal?.status).toBe("active");
    expect(file.executions.at(-1)?.origin).toBe("goal_continuation");

    await runtime.updateSessionGoalControl({ workspaceRoot, sessionId: session.sessionId, action: "pause" });
    await runtime.abortAllSessionExecutions();
    await runtime.shutdown();
  });

  test("does not retry an active Goal after a failed root Execution", async () => {
    const workspaceRoot = await makeTempRoot();
    const registryHome = await makeTempRoot();
    let streams = 0;
    setLlmAdapterForTest({
      streamText: mock(() => {
        streams += 1;
        if (streams === 1) return createGoalActivationStream("Keep working until the migration is complete.");
        throw Object.assign(new Error("provider failed after Goal activation"), { status: 400 });
      }) as never,
      generateText: mock(async () => ({ text: "", toolCalls: [] })) as never,
    });
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      projectRegistryHomeDir: registryHome,
      mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Goal failure" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead" });

    await runtime.acceptSessionMessage({
      slug: project.slug,
      workspaceRoot,
      sessionId: session.sessionId,
      text: "Keep working until the migration is complete.",
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection,
    });

    await waitFor(async () => (
      (await runtime.getSessionFile(workspaceRoot, session.sessionId)).executions.at(-1)?.status === "failed"
    ));
    const before = await runtime.getSessionFile(workspaceRoot, session.sessionId);
    expect(before.goal?.status).toBe("active");
    await Bun.sleep(40);
    const after = await runtime.getSessionFile(workspaceRoot, session.sessionId);
    expect(after.executions).toHaveLength(before.executions.length);
    expect(runtime.getSessionFamilyActivity(workspaceRoot, session.sessionId)).toBe("idle");

    await runtime.updateSessionGoalControl({ workspaceRoot, sessionId: session.sessionId, action: "pause" });
    await runtime.shutdown();
  });

  test("reconciles an answered Session HITL to its exact blocked call after restart", async () => {
    const workspaceRoot = await makeTempRoot();
    const registryHome = await makeTempRoot();
    const runtime1 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      projectRegistryHomeDir: registryHome,
      mcpManagerFactory: () => makeFakeMcpManager({ descriptors: [], warnings: [] }),
    });
    const project = await runtime1.projectRegistry.add({ workspaceRoot, name: "HITL restart" });
    const session = await runtime1.createSession(workspaceRoot, { agentName: "lead" });
    const context = await runtime1.contextResolver.resolve(workspaceRoot);
    const questionInput = {
      questions: [{
        question: "Continue?",
        header: "Continue",
        options: [{ label: "Yes", description: "Continue" }],
      }],
    };
    const questionDisplay = {
      title: "Continue",
      summary: "Continue?",
      questions: [{
        question: "Continue?",
        header: "Continue",
        options: [{ label: "Yes", description: "Continue" }],
        custom: true,
      }],
      redacted: true as const,
    };
    const firstRequest = context.hitl.codec.createAskUserRequest({ toolCallId: "question-1", displayPayload: questionDisplay });
    const first = (await context.hitl.create({
      requestKey: context.hitl.codec.createToolRequestKey({
        sessionId: session.sessionId,
        toolCallId: "question-1",
        toolName: "ask_user",
        request: firstRequest,
      }),
      owner: { type: "session", id: session.sessionId },
      source: firstRequest.source,
      displayPayload: firstRequest.displayPayload,
    })).record;
    const secondRequest = context.hitl.codec.createAskUserRequest({ toolCallId: "question-2", displayPayload: questionDisplay });
    const second = (await context.hitl.create({
      requestKey: context.hitl.codec.createToolRequestKey({
        sessionId: session.sessionId,
        toolCallId: "question-2",
        toolName: "ask_user",
        request: secondRequest,
      }),
      owner: { type: "session", id: session.sessionId },
      source: secondRequest.source,
      displayPayload: secondRequest.displayPayload,
    })).record;
    const now = new Date().toISOString();
    const batch: SessionToolBatch = {
      batchId: "batch-1",
      executionId: "execution-1",
      step: 0,
      agentName: "lead",
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
    expect((await runtime2.getSessionFile(workspaceRoot, session.sessionId)).toolBatches[0]?.calls[0]?.state).toBe("blocked");
    expect((await (await runtime2.contextResolver.resolve(workspaceRoot)).hitl.list()).find((record) => record.hitlId === first.hitlId)?.status).toBe("answered");
    installTestLlmAdapter();
    await runtime2.recoverSessionContinuations();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await runtime2.getSessionFile(workspaceRoot, session.sessionId);
      if (current.toolBatches[0]?.calls[0]?.state === "completed") break;
      await Bun.sleep(5);
    }

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
    expect(recoveredCalls?.[0]?.result?.output.preview).toContain("Yes");
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
    const session = await runtime1.createSession(workspaceRoot, { agentName: "lead" });
    const context1 = await runtime1.contextResolver.resolve(workspaceRoot);
    const concurrentDisplay = {
      title: "Continue",
      summary: "Continue?",
      questions: [{ question: "Continue?", header: "Continue", options: [], custom: true }],
      redacted: true as const,
    };
    const concurrentRequest = context1.hitl.codec.createAskUserRequest({
      toolCallId: "question-concurrent",
      displayPayload: concurrentDisplay,
    });
    const record = (await context1.hitl.create({
      requestKey: context1.hitl.codec.createToolRequestKey({
        sessionId: session.sessionId,
        toolCallId: "question-concurrent",
        toolName: "ask_user",
        request: concurrentRequest,
      }),
      owner: { type: "session", id: session.sessionId },
      source: concurrentRequest.source,
      displayPayload: concurrentRequest.displayPayload,
    })).record;
    const now = new Date().toISOString();
    const batch: SessionToolBatch = {
      batchId: "batch-concurrent",
      executionId: "execution-concurrent",
      step: 0,
      agentName: "lead",
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
    installTestLlmAdapter();
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

function installTestLlmAdapter(): void {
  setLlmAdapterForTest({
    streamText: mock(() => ({
      fullStream: (async function* () { yield { type: "text-delta", text: "Done." }; })(),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ totalTokens: 1 }),
      text: Promise.resolve("Done."),
      toolCalls: Promise.resolve([]),
    })) as never,
    generateText: mock(async () => ({ text: "Queued input" })) as never,
  });
}
