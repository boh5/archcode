import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import type { SpecraConfig } from "../config/index";
import type { SessionTranscriptState } from "../store/types";
import type { StoreApi } from "zustand";
import { TestAgent } from "./test-agent";
import { AgentRunningError, NoModelsConfiguredError } from "./test-agent";
import type { Agent, AgentResult } from "./test-agent";
import { createSessionStore } from "../store/store";
import { __setStreamTextForTest } from "./query/loop";
import { randomUUID } from "node:crypto";

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

function setupMockStreamText(text: string, finishReason = "stop") {
  const fn = mock((_opts: Record<string, unknown>) => {
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", text };
      })(),
      response: Promise.resolve({
        messages: [
          { role: "assistant", content: [{ type: "text", text }] },
        ],
      }),
      finishReason,
      text,
      toolCalls: [],
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

describe("TestAgent", () => {
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

      const agent = new TestAgent(makeMockConfig());

      expect(agent.store).toBeDefined();
      expect(agent.store.getState().sessionId).toBeDefined();
      expect(agent.store.getState().events).toEqual([]);
    });

    test("throws NoModelsConfiguredError when config has no models", () => {
      expect(() => new TestAgent(makeEmptyModelConfig())).toThrow(
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

      const agent = new TestAgent(makeMockConfig());
      const result = await agent.run("Hi");

      expect(result.text).toBe("Hello from agent");
      expect(result.steps).toBe(0);
    });

    test("appends user-message and text-delta events to store", async () => {
      setupMockStreamText("Hello");

      const agent = new TestAgent(makeMockConfig());
      await agent.run("My question");

      const events = agent.store.getState().events;

      const userMsg = events.find((e) => e.type === "user-message");
      expect(userMsg).toBeDefined();
      if (userMsg && userMsg.type === "user-message") {
        expect(userMsg.content).toBe("My question");
      }

      const textDelta = events.find((e) => e.type === "text-delta");
      expect(textDelta).toBeDefined();
    });

    test("does NOT duplicate user-message (runQueryLoop handles it)", async () => {
      setupMockStreamText("ok");

      const agent = new TestAgent(makeMockConfig());
      await agent.run("test");

      const events = agent.store.getState().events;
      const userMessages = events.filter((e) => e.type === "user-message");
      expect(userMessages.length).toBe(1);
    });

    test("passes hardcoded system prompt to runQueryLoop", async () => {
      const streamFn = setupMockStreamText("ok");

      const agent = new TestAgent(makeMockConfig());
      await agent.run("test");

      const callArgs = streamFn.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs.system).toBeDefined();
      expect(typeof callArgs.system).toBe("string");
      expect((callArgs.system as string).length).toBeGreaterThan(0);
    });

    test("records loop-error in store when streamText fails", async () => {
      setupFailingStreamText("model unavailable");

      const agent = new TestAgent(makeMockConfig());
      const result = await agent.run("test");

      const events = agent.store.getState().events;
      const loopError = events.find((e) => e.type === "loop-error");
      expect(loopError).toBeDefined();
      if (loopError && loopError.type === "loop-error") {
        expect(loopError.error).toContain("model unavailable");
      }
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
          response: slowPromise.then(() => ({
            messages: [
              { role: "assistant", content: [{ type: "text", text: "slow response" }] },
            ],
          })),
          finishReason: slowPromise.then(() => "stop"),
          text: slowPromise.then(() => "slow response"),
          toolCalls: slowPromise.then(() => []),
        };
      });

      __setStreamTextForTest(
        fn as unknown as typeof import("ai").streamText,
      );

      const agent = new TestAgent(makeMockConfig());

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

      const agent = new TestAgent(makeMockConfig());

      const result1 = await agent.run("first");
      expect(result1.text).toBe("response");

      const result2 = await agent.run("second");
      expect(result2.text).toBe("response");
    });
  });

  describe("Agent interface compliance", () => {
    test("TestAgent implements Agent interface (store + run)", () => {
      setupMockStreamText("ok");

      const agent: Agent = new TestAgent(makeMockConfig());

      expect(agent.store).toBeDefined();
      expect(typeof agent.run).toBe("function");
    });

    test("AgentResult has correct shape", async () => {
      setupMockStreamText("Hello");

      const agent = new TestAgent(makeMockConfig());
      const result: AgentResult = await agent.run("test");

      expect(result).toHaveProperty("text");
      expect(result).toHaveProperty("steps");
      expect(typeof result.text).toBe("string");
      expect(typeof result.steps).toBe("number");
    });
  });
});
