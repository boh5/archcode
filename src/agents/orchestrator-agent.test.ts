import { describe, expect, test, mock, afterAll, afterEach, beforeAll } from "bun:test";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { z } from "zod";
import type { SpecraConfig } from "../config/index";
import { createRegistry as createProviderRegistry } from "../provider/index";
import { createRegistry as createToolRegistry, defineTool } from "../tools/index";
import type { AskUserCallback, ToolConfirmationCallback, ToolExecutionContext } from "../tools/index";
import { registerBuiltinTools } from "../core/index";
import { OrchestratorAgent } from "./orchestrator-agent";
import { AgentRunningError, NoModelsConfiguredError } from "./orchestrator-agent";
import type { Agent, AgentResult } from "./orchestrator-agent";
import { __setStreamTextForTest } from "./query/loop";

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

function makeTestAgent(): OrchestratorAgent {
  const providerRegistry = createProviderRegistry(makeMockConfig().provider);
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);
  return new OrchestratorAgent({ providerRegistry, toolRegistry });
}

function makeTestAgentWithConfirmation(
  confirmPermission: ToolConfirmationCallback,
): OrchestratorAgent {
  const providerRegistry = createProviderRegistry(makeMockConfig().provider);
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);
  return new OrchestratorAgent({ providerRegistry, toolRegistry, confirmPermission });
}

function makeEmptyModelTestAgent(): OrchestratorAgent {
  const providerRegistry = createProviderRegistry(makeEmptyModelConfig().provider);
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);
  return new OrchestratorAgent({ providerRegistry, toolRegistry });
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

function setupFailingStreamText(error: string) {
  const fn = mock(() => {
    throw new Error(error);
  });

  __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);
  return fn;
}

describe("OrchestratorAgent", () => {
  afterEach(() => {
    __setStreamTextForTest(
      (() => {
        throw new Error("streamText not mocked");
      }) as unknown as typeof import("ai").streamText,
    );
  });

  describe("constructor", () => {
    test("creates agent with valid config", () => {
      setupMockStreamText("ok");

      const agent = makeTestAgent();

      expect(agent.store).toBeDefined();
      expect(agent.store.getState().sessionId).toBeDefined();
      expect(agent.store.getState().messages).toEqual([]);
    });

    test("throws NoModelsConfiguredError when config has no models", () => {
      expect(() => makeEmptyModelTestAgent()).toThrow(
        NoModelsConfiguredError,
      );
    });

    test("NoModelsConfiguredError has correct name and message", () => {
      const err = new NoModelsConfiguredError();
      expect(err.name).toBe("NoModelsConfiguredError");
      expect(err.message).toContain("No models configured");
    });
  });

  describe("run", () => {
    test("returns AgentResult with text and steps", async () => {
      setupMockStreamText("Hello from agent");

      const agent = makeTestAgent();
      const result = await agent.run("Hi");

      expect(result.text).toBe("Hello from agent");
      expect(result.steps).toBe(0);
    });

    test("passes SubAgentManager and root depth to delegate tools", async () => {
      let callCount = 0;
      const fn = mock(() => {
        callCount += 1;
        const shouldDelegate = callCount === 1;
        return {
          fullStream: (async function* () {
            if (shouldDelegate) {
              yield {
                type: "tool-call",
                toolCallId: "delegate-call",
                toolName: "delegate",
                input: { agent_type: "explore", prompt: "inspect", background: false },
              };
            }
          })(),
          finishReason: Promise.resolve(shouldDelegate ? "tool-calls" : "stop"),
          text: Promise.resolve(shouldDelegate ? "" : "done"),
          toolCalls: Promise.resolve(
            shouldDelegate
              ? [
                  {
                    toolCallId: "delegate-call",
                    toolName: "delegate",
                    input: { agent_type: "explore", prompt: "inspect", background: false },
                  },
                ]
              : [],
          ),
          usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
        };
      });

      __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);
      const agent = makeTestAgent();

      await agent.run("delegate");

      const toolPart = agent.store.getState().messages.flatMap((message) => message.parts).find(
        (part) => part.type === "tool" && part.toolName === "delegate",
      );
      expect(toolPart).toBeDefined();
      expect(toolPart?.type === "tool" && toolPart.state === "completed" ? toolPart.output : "").not.toContain(
        "SubAgentManager is not available",
      );
    });

    test("appends user and assistant messages to store", async () => {
      setupMockStreamText("Hello");

      const agent = makeTestAgent();
      await agent.run("My question");

      const messages = agent.store.getState().messages;

      const userMsg = messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.parts.length).toBeGreaterThan(0);
      const userTextPart = userMsg!.parts.find((p) => p.type === "text");
      expect(userTextPart).toBeDefined();
      expect(userTextPart!.text).toBe("My question");

      const assistantMsg = messages.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      const assistantTextPart = assistantMsg!.parts.find((p) => p.type === "text");
      expect(assistantTextPart).toBeDefined();
      expect(assistantTextPart!.text).toBe("Hello");
    });

    test("does NOT duplicate user-message (runQueryLoop handles it)", async () => {
      setupMockStreamText("ok");

      const agent = makeTestAgent();
      await agent.run("test");

      const messages = agent.store.getState().messages;
      const userMessages = messages.filter((m) => m.role === "user");
      expect(userMessages.length).toBe(1);
    });

    test("passes assembled system prompt to runQueryLoop", async () => {
      const streamFn = setupMockStreamText("ok");

      const agent = makeTestAgent();
      await agent.run("test");

      const callArgs = streamFn.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs.system).toBeDefined();
      expect(typeof callArgs.system).toBe("string");
      const systemPrompt = callArgs.system as string;
      expect(systemPrompt).toContain("Specra");
      expect(systemPrompt).toContain("## Tools");
      expect(systemPrompt).toContain("## Environment");
      expect(systemPrompt).toContain("## Guidelines");
    });

    test("passes all registered tool names as allowedTools to query loop", async () => {
      const streamFn = setupMockStreamText("ok");

      const agent = makeTestAgent();
      await agent.run("test");

      const callArgs = streamFn.mock.calls[0][0] as Record<string, unknown>;
      expect("tools" in callArgs).toBe(true);
      const toolNames = Object.keys(callArgs.tools as Record<string, unknown>);
      expect(toolNames).toContain("file_read");
      expect(toolNames).toContain("file_write");
      expect(toolNames).toContain("file_edit");
      expect(toolNames).toContain("grep");
      expect(toolNames).toContain("glob");
      expect(toolNames).toContain("git_status");
      expect(toolNames).toContain("git_diff");
    });

    test("propagates confirmation callback to query loop tool context", async () => {
      const confirmPermission = mock(async () => "approve" as const);
      let contextConfirmPermission: ToolExecutionContext["confirmPermission"];
      const providerRegistry = createProviderRegistry(makeMockConfig().provider);
      const toolRegistry = createToolRegistry();
      toolRegistry.register(
        defineTool({
          name: "echo",
          description: "Echo test tool",
          inputSchema: z.object({}).strict(),
          traits: { readOnly: true, destructive: false, concurrencySafe: true },
          execute: async () => "ok",
        }),
      );
      toolRegistry.globalHooks.after.push((result, ctx) => {
        contextConfirmPermission = ctx.confirmPermission;
        return result;
      });
      const fn = mock(() => ({
        fullStream: (async function* () {
          yield { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} };
        })(),
        finishReason: Promise.resolve("tool-calls"),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([{ toolCallId: "tc-1", toolName: "echo", input: {} }]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      }));
      __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);

      const agent = new OrchestratorAgent({ providerRegistry, toolRegistry, confirmPermission });
      await agent.run("test");

      expect(contextConfirmPermission).toBe(confirmPermission);
    });

    test("run() confirmPermission parameter overrides constructor callback", async () => {
      const constructorCallback = mock(async () => "deny" as const);
      const runCallback = mock(async () => "approve" as const);
      let contextConfirmPermission: ToolExecutionContext["confirmPermission"];
      const providerRegistry = createProviderRegistry(makeMockConfig().provider);
      const toolRegistry = createToolRegistry();
      toolRegistry.register(
        defineTool({
          name: "echo",
          description: "Echo test tool",
          inputSchema: z.object({}).strict(),
          traits: { readOnly: true, destructive: false, concurrencySafe: true },
          execute: async () => "ok",
        }),
      );
      toolRegistry.globalHooks.after.push((result, ctx) => {
        contextConfirmPermission = ctx.confirmPermission;
        return result;
      });
      const fn = mock(() => ({
        fullStream: (async function* () {
          yield { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} };
        })(),
        finishReason: Promise.resolve("tool-calls"),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([{ toolCallId: "tc-1", toolName: "echo", input: {} }]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      }));
      __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);

      const agent = new OrchestratorAgent({ providerRegistry, toolRegistry, confirmPermission: constructorCallback });
      await agent.run("test", undefined, runCallback);

      expect(contextConfirmPermission).toBe(runCallback);
      expect(constructorCallback).not.toHaveBeenCalled();
    });

    test("run() falls back to constructor callback when no run-time callback provided", async () => {
      const constructorCallback = mock(async () => "approve" as const);
      let contextConfirmPermission: ToolExecutionContext["confirmPermission"];
      const providerRegistry = createProviderRegistry(makeMockConfig().provider);
      const toolRegistry = createToolRegistry();
      toolRegistry.register(
        defineTool({
          name: "echo",
          description: "Echo test tool",
          inputSchema: z.object({}).strict(),
          traits: { readOnly: true, destructive: false, concurrencySafe: true },
          execute: async () => "ok",
        }),
      );
      toolRegistry.globalHooks.after.push((result, ctx) => {
        contextConfirmPermission = ctx.confirmPermission;
        return result;
      });
      const fn = mock(() => ({
        fullStream: (async function* () {
          yield { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} };
        })(),
        finishReason: Promise.resolve("tool-calls"),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([{ toolCallId: "tc-1", toolName: "echo", input: {} }]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      }));
      __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);

      const agent = new OrchestratorAgent({ providerRegistry, toolRegistry, confirmPermission: constructorCallback });
      await agent.run("test");

      expect(contextConfirmPermission).toBe(constructorCallback);
    });

    test("records loop-error in store when streamText fails", async () => {
      setupFailingStreamText("model unavailable");

      const agent = makeTestAgent();
      await agent.run("test");

      // Agent catch + runQueryLoop internal catch both record errors
      const steps = agent.store.getState().steps;
      const errorStep = steps.find((s) => s.error !== undefined);
      expect(errorStep).toBeDefined();
      expect(errorStep!.error).toContain("model unavailable");
    });

    test("preserves memory across multiple runs", async () => {
      setupMockStreamText("response");

      const agent = makeTestAgent();

      await agent.run("first");
      const firstRunMessages = agent.store.getState().messages;
      expect(firstRunMessages.length).toBeGreaterThan(0);

      await agent.run("second");
      const secondRunMessages = agent.store.getState().messages;
      expect(secondRunMessages.length).toBeGreaterThan(firstRunMessages.length);
    });
  });

  describe("concurrency protection", () => {
    test("throws AgentRunningError when run() is called while already running", async () => {
      let resolveStream: () => void;
      const slowPromise = new Promise<void>((resolve) => {
        resolveStream = resolve;
      });

      const fn = mock((_opts: Record<string, unknown>) => {
        const fullStream = (async function* () {
          yield { type: "text-delta", text: "slow" };
        })();
        return {
          fullStream,
          finishReason: slowPromise.then(() => "stop"),
          text: slowPromise.then(() => "slow response"),
          toolCalls: slowPromise.then(() => []),
          usage: slowPromise.then(() => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })),
        };
      });

      __setStreamTextForTest(
        fn as unknown as typeof import("ai").streamText,
      );

      const agent = makeTestAgent();

      const firstRun = agent.run("first");

      try {
        await agent.run("second");
        expect.unreachable("Should have thrown AgentRunningError");
      } catch (err) {
        expect(err).toBeInstanceOf(AgentRunningError);
      }

      resolveStream!();
      const result = await firstRun;
      expect(result.text).toBe("slow response");
    });

    test("AgentRunningError has correct name and message", () => {
      const err = new AgentRunningError();
      expect(err.name).toBe("AgentRunningError");
      expect(err.message).toContain("already running");
    });

    test("allows run() again after previous run completes", async () => {
      setupMockStreamText("response");

      const agent = makeTestAgent();

      const result1 = await agent.run("first");
      expect(result1.text).toBe("response");

      const result2 = await agent.run("second");
      expect(result2.text).toBe("response");
    });
  });

  describe("Agent interface compliance", () => {
    test("OrchestratorAgent implements Agent interface (store + run)", () => {
      setupMockStreamText("ok");

      const agent: Agent = makeTestAgent();

      expect(agent.store).toBeDefined();
      expect(typeof agent.run).toBe("function");
    });

    test("AgentResult has correct shape", async () => {
      setupMockStreamText("Hello");

      const agent = makeTestAgent();
      const result: AgentResult = await agent.run("test");

      expect(result).toHaveProperty("text");
      expect(result).toHaveProperty("steps");
      expect(typeof result.text).toBe("string");
      expect(typeof result.steps).toBe("number");
    });
  });

  describe("askUser callback", () => {
    test("passes askUser callback to tool execution context via options object", async () => {
      const askUser = mock(async () => ({ answers: [["yes"]] }) as { answers: string[][] }) as AskUserCallback;
      let contextAskUser: ToolExecutionContext["askUser"];
      const providerRegistry = createProviderRegistry(makeMockConfig().provider);
      const toolRegistry = createToolRegistry();
      toolRegistry.register(
        defineTool({
          name: "echo",
          description: "Echo test tool",
          inputSchema: z.object({}).strict(),
          traits: { readOnly: true, destructive: false, concurrencySafe: true },
          execute: async () => "ok",
        }),
      );
      toolRegistry.globalHooks.after.push((result, ctx) => {
        contextAskUser = ctx.askUser;
        return result;
      });
      const fn = mock(() => ({
        fullStream: (async function* () {
          yield { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} };
        })(),
        finishReason: Promise.resolve("tool-calls"),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([{ toolCallId: "tc-1", toolName: "echo", input: {} }]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      }));
      __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);

      const agent = new OrchestratorAgent({ providerRegistry, toolRegistry, askUser });
      await agent.run("test", { askUser });

      expect(contextAskUser).toBe(askUser);
    });

    test("run() with positional args still works (backward compatibility)", async () => {
      setupMockStreamText("Hello from positional");

      const agent = makeTestAgent();
      const result = await agent.run("test", undefined, undefined);

      expect(result.text).toBe("Hello from positional");
    });

    test("run() with options object works", async () => {
      setupMockStreamText("Hello from options");

      const agent = makeTestAgent();
      const result = await agent.run("test", {});

      expect(result.text).toBe("Hello from options");
    });

    test("run() options.askUser overrides constructor askUser", async () => {
      const constructorAskUser = mock(async () => ({ answers: [["constructor"]] }) as { answers: string[][] }) as AskUserCallback;
      const runAskUser = mock(async () => ({ answers: [["runtime"]] }) as { answers: string[][] }) as AskUserCallback;
      let contextAskUser: ToolExecutionContext["askUser"];
      const providerRegistry = createProviderRegistry(makeMockConfig().provider);
      const toolRegistry = createToolRegistry();
      toolRegistry.register(
        defineTool({
          name: "echo",
          description: "Echo test tool",
          inputSchema: z.object({}).strict(),
          traits: { readOnly: true, destructive: false, concurrencySafe: true },
          execute: async () => "ok",
        }),
      );
      toolRegistry.globalHooks.after.push((result, ctx) => {
        contextAskUser = ctx.askUser;
        return result;
      });
      const fn = mock(() => ({
        fullStream: (async function* () {
          yield { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} };
        })(),
        finishReason: Promise.resolve("tool-calls"),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([{ toolCallId: "tc-1", toolName: "echo", input: {} }]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      }));
      __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);

      const agent = new OrchestratorAgent({ providerRegistry, toolRegistry, askUser: constructorAskUser });
      await agent.run("test", { askUser: runAskUser });

      expect(contextAskUser).toBe(runAskUser);
      expect(constructorAskUser).not.toHaveBeenCalled();
    });

    test("run() falls back to constructor askUser when not provided in options", async () => {
      const constructorAskUser = mock(async () => ({ answers: [["constructor"]] }) as { answers: string[][] }) as AskUserCallback;
      let contextAskUser: ToolExecutionContext["askUser"];
      const providerRegistry = createProviderRegistry(makeMockConfig().provider);
      const toolRegistry = createToolRegistry();
      toolRegistry.register(
        defineTool({
          name: "echo",
          description: "Echo test tool",
          inputSchema: z.object({}).strict(),
          traits: { readOnly: true, destructive: false, concurrencySafe: true },
          execute: async () => "ok",
        }),
      );
      toolRegistry.globalHooks.after.push((result, ctx) => {
        contextAskUser = ctx.askUser;
        return result;
      });
      const fn = mock(() => ({
        fullStream: (async function* () {
          yield { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} };
        })(),
        finishReason: Promise.resolve("tool-calls"),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([{ toolCallId: "tc-1", toolName: "echo", input: {} }]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      }));
      __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);

      const agent = new OrchestratorAgent({ providerRegistry, toolRegistry, askUser: constructorAskUser });
      await agent.run("test");

      expect(contextAskUser).toBe(constructorAskUser);
    });

describe("session persistence", () => {
  const TEST_TMP = join(import.meta.dir, "__test_tmp__", "session-persistence");

  beforeAll(async () => {
    await mkdir(TEST_TMP, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_TMP, { recursive: true, force: true });
  });

  test("saves session transcript to JSON file on run completion", async () => {
    setupMockStreamText("Hello from persisted agent");

    const agent = makeTestAgent();
    const sessionId = agent.store.getState().sessionId;

    const origEnvDir = process.env.SPECRA_SESSIONS_DIR;
    process.env.SPECRA_SESSIONS_DIR = TEST_TMP;

    try {
      const result = await agent.run("test message");
      expect(result.text).toBe("Hello from persisted agent");

      const filePath = join(TEST_TMP, `${sessionId}.json`);
      const file = Bun.file(filePath);
      expect(await file.exists()).toBe(true);

      const content = JSON.parse(await file.text());

      expect(content.sessionId).toBe(sessionId);
      expect(typeof content.createdAt).toBe("number");
      expect(content.createdAt).toBeGreaterThan(0);
      expect(Array.isArray(content.messages)).toBe(true);
      expect(content.messages.length).toBeGreaterThan(0);
      expect(Array.isArray(content.steps)).toBe(true);
      expect(Array.isArray(content.todos)).toBe(true);
      expect(content.streamingText).toBeUndefined();
      expect(content.streamingReasoning).toBeUndefined();
      expect(content.streamingTools).toBeUndefined();
      expect(content.readSnapshots).toBeUndefined();
      expect(content.isRunning).toBeUndefined();
      expect(content.currentRunId).toBeUndefined();
    } finally {
      process.env.SPECRA_SESSIONS_DIR = origEnvDir;
    }
  });

});

    test("askUser is separate from confirmPermission in tool context", async () => {
      const confirmPermission = mock(async () => "approve" as const);
      const askUser = mock(async () => ({ answers: [["yes"]] }) as { answers: string[][] }) as AskUserCallback;
      let contextConfirm: ToolExecutionContext["confirmPermission"];
      let contextAskUser: ToolExecutionContext["askUser"];
      const providerRegistry = createProviderRegistry(makeMockConfig().provider);
      const toolRegistry = createToolRegistry();
      toolRegistry.register(
        defineTool({
          name: "echo",
          description: "Echo test tool",
          inputSchema: z.object({}).strict(),
          traits: { readOnly: true, destructive: false, concurrencySafe: true },
          execute: async () => "ok",
        }),
      );
      toolRegistry.globalHooks.after.push((result, ctx) => {
        contextConfirm = ctx.confirmPermission;
        contextAskUser = ctx.askUser;
        return result;
      });
      const fn = mock(() => ({
        fullStream: (async function* () {
          yield { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} };
        })(),
        finishReason: Promise.resolve("tool-calls"),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([{ toolCallId: "tc-1", toolName: "echo", input: {} }]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      }));
      __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);

      const agent = new OrchestratorAgent({ providerRegistry, toolRegistry });
      await agent.run("test", { confirmPermission, askUser });

      expect(contextConfirm).toBe(confirmPermission);
      expect(contextAskUser).toBe(askUser);
      expect(contextAskUser).not.toBe(contextConfirm);
    });
  });
});
