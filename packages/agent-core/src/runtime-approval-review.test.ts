import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { ServerConfigUpdate, SessionMessage } from "@archcode/protocol";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";

import { ServerConfigService, resolveServerConfigPath } from "./config";
import { setLlmAdapterForTest } from "./llm";
import { silentLogger } from "./logger";
import { ProjectRegistry } from "./projects/registry";
import { createRuntime } from "./runtime";
import { SessionStoreManager } from "./store/session-store-manager";
import { createTestMcpRuntime } from "./testing/test-mcp-runtime";
import { defineTool } from "./tools/define-tool";
import { createTextToolResult } from "./tools/results";
import { createToolExecutionContext } from "./tools/types";

const roots: string[] = [];

afterEach(() => setLlmAdapterForTest(undefined));
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("Runtime approval review policy", () => {
  test("applies Config enable and disable changes to the next unresolved ask without rebuilding Runtime", async () => {
    // Keep the workspace isolated without inheriting macOS TMPDIR's long
    // alphanumeric segment, which is intentionally classified as secret-shaped.
    const root = join("/tmp", `archcode-runtime-approval-review-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    roots.push(root);
    const configHome = join(root, "home");
    const workspaceRoot = join(root, "project");
    await Promise.all([
      mkdir(join(configHome, ".archcode"), { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
    ]);
    await writeFile(resolveServerConfigPath(configHome), JSON.stringify(testConfig()));
    const configService = new ServerConfigService({ homeDir: configHome });
    const activation = await configService.activateForStartup();
    if (activation.status !== "ready") throw new Error(`Expected ready Config, received ${activation.status}`);

    const reviewCalls = mock(async () => ({
      text: "",
      toolCalls: [{
        toolName: "approval_review",
        input: { decision: "approve" },
      }],
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, cachedInputTokens: 10 },
    }));
    setLlmAdapterForTest({ generateText: reviewCalls as never });
    const runtime = await createRuntime({
      configService,
      activation: activation.activation,
      projectRegistry: new ProjectRegistry({ homeDir: root, logger: silentLogger }),
      runtimeStorageHomeDir: root,
      mcpRuntimeFactory: () => createTestMcpRuntime(),
      logger: silentLogger,
    });
    try {
      await runtime.projectRegistry.add({ workspaceRoot, name: "Approval review" });
      const projectContext = await runtime.contextResolver.resolve(workspaceRoot);
      const storeManager = new SessionStoreManager({ logger: silentLogger });
      const sessionId = crypto.randomUUID();
      const store = storeManager.create(sessionId, workspaceRoot, {
        source: { kind: "direct" },
        agentName: "lead",
      });
      store.setState({ messages: [trustedUserMessage("Approve the requested review test action")] });
      await storeManager.flushSession(sessionId, workspaceRoot);

      const toolName = "approval_review_runtime_test";
      runtime.toolRegistry.register(defineTool({
        name: toolName,
        description: "Runtime approval review test action",
        inputSchema: z.strictObject({ value: z.string() }),
        traits: { readOnly: false, destructive: false, concurrencySafe: true },
        outputPolicy: { kind: "inline", previewDirection: "head" },
        permissions: [async () => ({
          outcome: "ask",
          source: "tool-guard",
          ruleId: "runtime-review-test",
          reason: "Test action requires approval",
        })],
        execute: async (input) => createTextToolResult(input.value),
      }));
      const execute = async (toolCallId: string) => await runtime.toolRegistry.execute(
        { toolName, toolCallId, input: { value: toolCallId } },
        createToolExecutionContext({
          store,
          storeManager,
          toolName,
          toolCallId,
          input: { value: toolCallId },
          step: 0,
          executionId: `execution-${toolCallId}`,
          runOrdinal: 0,
          toolBatchId: `batch-${toolCallId}`,
          abort: new AbortController().signal,
          agentName: "lead",
          startedAt: Date.now(),
          allowedTools: new Set([toolName]),
          projectContext,
          cwd: workspaceRoot,
          currentDepth: 0,
        }),
      );

      expect((await execute("enabled-1")).kind).toBe("settled");
      expect(reviewCalls).toHaveBeenCalledTimes(1);

      await saveAutoReview(configService, false);
      expect((await execute("disabled")).kind).toBe("blocked");
      expect(reviewCalls).toHaveBeenCalledTimes(1);

      await saveAutoReview(configService, true);
      expect((await execute("enabled-2")).kind).toBe("settled");
      expect(reviewCalls).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.shutdown();
    }
  });
});

async function saveAutoReview(service: ServerConfigService, autoReview: boolean): Promise<void> {
  const snapshot = await service.getSnapshot();
  const config = structuredClone(snapshot.config) as unknown as ServerConfigUpdate;
  config.provider.local!.options!.apiKey = { action: "preserve" };
  config.permissions = { autoReview };
  await service.save({ expectedRevision: snapshot.revision, config });
}

function trustedUserMessage(text: string): SessionMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    inputSource: "user",
    createdAt: 1,
    parts: [{
      type: "text",
      id: crypto.randomUUID(),
      text,
      createdAt: 1,
      completedAt: 1,
    }],
  };
}

function testConfig(): Record<string, unknown> {
  return {
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local LLM",
        options: { baseURL: "http://localhost:8090/v1", apiKey: "test-key" },
        models: {
          "test-model": {
            name: "Test Model",
            limit: { context: 128_000, output: 8_192 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    profiles: {
      principal: { model: "local:test-model" },
      deep: { model: "local:test-model" },
      fast: { model: "local:test-model" },
    },
    permissions: { autoReview: true },
    mcp: { servers: {} },
  };
}
