import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SpecraConfig } from "../../config/index";
import { registerBuiltinTools } from "../../core/index";
import { createRegistry as createProviderRegistry } from "../../provider/index";
import { createSessionStore } from "../../store/store";
import { createRegistry as createToolRegistry } from "../../tools/index";
import { ExplorerAgent } from "./explorer-agent";
import { DELEGATION_TOOLS, EXPLORER_READ_ONLY_TOOLS } from "../constants";
import { AgentRunningError, NoModelsConfiguredError } from "../errors";
import { __setStreamTextForTest } from "../query/loop";

function makeMockConfig(): SpecraConfig {
  return {
    $schema: "https://specra.dev/schema.json",
    provider: {
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
            limits: { context: 128000, output: 8192 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
  } as unknown as SpecraConfig;
}

function makeEmptyModelConfig(): SpecraConfig {
  return {
    $schema: "https://specra.dev/schema.json",
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local LLM",
        options: {
          baseURL: "http://localhost:8090/v1",
          apiKey: "test-key",
        },
        models: {},
      },
    },
  } as unknown as SpecraConfig;
}

function makeTestAgent(): ExplorerAgent {
  const providerRegistry = createProviderRegistry(makeMockConfig().provider);
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);
  return new ExplorerAgent({ providerRegistry, toolRegistry });
}

function makeTestAgentAtDepth(depth: number): ExplorerAgent {
  const providerRegistry = createProviderRegistry(makeMockConfig().provider);
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);
  return new ExplorerAgent({ providerRegistry, toolRegistry, depth });
}

function setupMockStreamText(text: string, finishReason = "stop") {
  const fn = mock((_opts: Record<string, unknown>) => {
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", text };
      })(),
      finishReason: Promise.resolve(finishReason),
      text: Promise.resolve(text),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    };
  });

  __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);
  return fn;
}

describe("ExplorerAgent", () => {
  afterEach(() => {
    __setStreamTextForTest(
      (() => {
        throw new Error("streamText not mocked");
      }) as unknown as typeof import("ai").streamText,
    );
  });

  test("creates with depth 0 tool set intersected with registry", async () => {
    const streamFn = setupMockStreamText("ok");

    const agent = makeTestAgent();
    await agent.run("explore");

    const callArgs = streamFn.mock.calls[0][0] as Record<string, unknown>;
    const toolNames = Object.keys(callArgs.tools as Record<string, unknown>);
    expect(new Set(toolNames)).toEqual(new Set([...EXPLORER_READ_ONLY_TOOLS, ...DELEGATION_TOOLS]));
  });

  test("depth 2 excludes delegation tools", async () => {
    const streamFn = setupMockStreamText("ok");

    const agent = makeTestAgentAtDepth(2);
    await agent.run("explore");

    const callArgs = streamFn.mock.calls[0][0] as Record<string, unknown>;
    const toolNames = Object.keys(callArgs.tools as Record<string, unknown>);
    expect(new Set(toolNames)).toEqual(new Set(EXPLORER_READ_ONLY_TOOLS));
    expect(toolNames).not.toContain("delegate");
    expect(toolNames).not.toContain("wait_for_reminder");
    expect(toolNames).not.toContain("background_output");
  });

  test('uses "explorer" agentId in prompt', async () => {
    const streamFn = setupMockStreamText("ok");

    const agent = makeTestAgent();
    await agent.run("explore");

    const callArgs = streamFn.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.system).toContain("You are Specra, a coding assistant agent (explorer).");
  });

  test("uses injected store when provided", async () => {
    setupMockStreamText("ok");
    const providerRegistry = createProviderRegistry(makeMockConfig().provider);
    const toolRegistry = createToolRegistry();
    registerBuiltinTools(toolRegistry);
    const store = createSessionStore(crypto.randomUUID());

    const agent = new ExplorerAgent({ providerRegistry, toolRegistry, store });
    await agent.run("explore");

    expect(agent.store).toBe(store);
    const userMessage = agent.store.getState().messages.find((message) => message.role === "user");
    const textPart = userMessage?.parts.find((part) => part.type === "text");
    expect(textPart?.text).toBe("explore");
  });

  test("excludes file_write, file_edit, and bash from allowed tools", async () => {
    const streamFn = setupMockStreamText("ok");

    const agent = makeTestAgent();
    await agent.run("explore");

    const callArgs = streamFn.mock.calls[0][0] as Record<string, unknown>;
    const toolNames = Object.keys(callArgs.tools as Record<string, unknown>);
    expect(toolNames).not.toContain("file_write");
    expect(toolNames).not.toContain("file_edit");
    expect(toolNames).not.toContain("bash");
  });

  test("omits read-only tools that are not registered", async () => {
    const streamFn = setupMockStreamText("ok");
    const providerRegistry = createProviderRegistry(makeMockConfig().provider);
    const toolRegistry = createToolRegistry();

    const agent = new ExplorerAgent({ providerRegistry, toolRegistry });
    await agent.run("explore");

    const callArgs = streamFn.mock.calls[0][0] as Record<string, unknown>;
    expect("tools" in callArgs).toBe(false);
  });

  test("throws NoModelsConfiguredError when no models are configured", () => {
    const providerRegistry = createProviderRegistry(makeEmptyModelConfig().provider);
    const toolRegistry = createToolRegistry();

    expect(() => new ExplorerAgent({ providerRegistry, toolRegistry })).toThrow(NoModelsConfiguredError);
  });

  test("throws AgentRunningError when already running", async () => {
    let resolveStream: () => void;
    const slowPromise = new Promise<void>((resolve) => {
      resolveStream = resolve;
    });

    const fn = mock((_opts: Record<string, unknown>) => {
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "slow" };
        })(),
        finishReason: slowPromise.then(() => "stop"),
        text: slowPromise.then(() => "slow response"),
        toolCalls: slowPromise.then(() => []),
        usage: slowPromise.then(() => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })),
      };
    });

    __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);
    const agent = makeTestAgent();

    const firstRun = agent.run("first");

    try {
      await agent.run("second");
      expect.unreachable("Should have thrown AgentRunningError");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentRunningError);
    }

    resolveStream!();
    await firstRun;
  });
});
