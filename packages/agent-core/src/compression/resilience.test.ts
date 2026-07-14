import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createEmptySessionStats } from "@archcode/protocol";
import { setLlmAdapterForTest } from "../llm";
import { silentLogger } from "../logger";
import type { ModelInfo } from "../provider/model";
import { SessionFileSchema } from "../store/helpers";
import { storeManager } from "../store/store";
import type { StoredMessage } from "../store/types";
import { createCompactCommand } from "../commands/compact";
import type { CommandContext } from "../commands/types";
import { SkillService } from "../skills";
import { createEmptyCompressionState } from "./index";

const modelInfo = {
  model: { modelId: "mock" } as never,
  displayName: "Mock",
  limit: { context: 1000, output: 1000 },
  modalities: { input: ["text"], output: ["text"] },
  providerId: "test",
  modelId: "mock",
  qualifiedId: "test:mock",
} as ModelInfo;
const skillService = new SkillService({ builtinSkills: {} });
const TEST_WORKSPACE_ROOT = `/tmp/archcode-agent-core-compression-resilience-${crypto.randomUUID()}`;

function commandContext(store: CommandContext["store"]): CommandContext {
  return {
    store,
    modelInfo,
    logger: silentLogger,
    cwd: import.meta.dir,
    agentName: "engineer",
    agentSkills: [],
    skillService,
  };
}

beforeEach(() => {
  storeManager.clearAll();
});

afterEach(() => {
  setLlmAdapterForTest(undefined);
  storeManager.clearAll();
});

function message(index: number): StoredMessage {
  return {
    id: `msg-${index}`,
    role: index % 2 === 1 ? "user" : "assistant",
    parts: [{ type: "text", id: `text-${index}`, text: `message ${index}`, createdAt: 1, completedAt: 2 }],
    createdAt: 1,
    completedAt: 2,
  };
}

function compactableMessages(): StoredMessage[] {
  return Array.from({ length: 11 }, (_, index) => message(index + 1));
}

function makeStore(sessionId = `compression-resilience-${crypto.randomUUID()}`) {
  const store = storeManager.create(sessionId, TEST_WORKSPACE_ROOT, { agentName: "engineer" });
  store.setState({ messages: compactableMessages() });
  return store;
}

function sessionFileFixture(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    createdAt: 1,
    updatedAt: 1,
    cwd: TEST_WORKSPACE_ROOT,
    agentName: "engineer",
    modelInfo: null,
    title: null,
    messages: [],
    steps: [],
    stats: createEmptySessionStats(),
    executions: [],
    compression: createEmptyCompressionState(),
    todos: [],
    reminders: [],
    childSessionLinks: [],
    toolBatches: [],
    rootSessionId: "session-1",
    ...overrides,
  };
}

describe("compression resilience", () => {
  test("single-flight manual compact prevents duplicate concurrent hard compacts", async () => {
    let releaseSummary!: (summary: string) => void;
    const streamText = mock(() => ({
      text: new Promise<string>((resolve) => {
        releaseSummary = resolve;
      }),
      fullStream: (async function* () {})(),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ totalTokens: 1 }),
      toolCalls: Promise.resolve([]),
      toolResults: Promise.resolve([]),
    }));
    setLlmAdapterForTest({ streamText: streamText as never });
    const store = makeStore();
    const command = createCompactCommand(store, modelInfo);

    const first = command.handler(commandContext(store));
    await waitUntil(() => releaseSummary !== undefined);
    const second = await command.handler(commandContext(store));

    releaseSummary("## Current Objective\nContinue the current task");
    const firstResult = await first;

    expect(firstResult.success).toBe(true);
    expect(second).toEqual({ success: false, message: "Compact already in progress" });
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(store.getState().compression?.activeBlockRefs).toEqual([]);
    expect(store.getState().events.filter((event) => event.payload.type === "compact")).toHaveLength(1);
    expect(store.getState().events.filter((event) => event.payload.type === "compression.block_committed")).toHaveLength(0);
  });

  test("corrupt compression metadata is rejected instead of hydrating partial state", () => {
    const corruptCompression = {
      ...createEmptyCompressionState(),
      activeBlockRefs: ["not-a-block-ref"],
      blocksByRef: {},
    };

    const parsed = SessionFileSchema.safeParse(sessionFileFixture({ compression: corruptCompression }));

    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected corrupt compression metadata to fail validation");
    expect(String(parsed.error)).toContain("compression");
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition was not met before timeout");
}
