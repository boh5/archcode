import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createEmptySessionStats } from "@archcode/protocol";
import { setLlmAdapterForTest } from "../llm";
import { silentLogger } from "../logger";
import type { ModelInfo } from "../provider/model";
import { SessionFileSchema } from "../store/helpers";
import { storeManager } from "../store/store";
import type { StoredMessage } from "../store/types";
import { createCompactCommand } from "../commands/compact";
import { createEmptyCompressionState, prepareHardLimitCompression } from "./index";

const modelInfo = {
  model: { modelId: "mock" } as never,
  displayName: "Mock",
  limit: { context: 1000, output: 1000 },
  modalities: { input: ["text"], output: ["text"] },
  providerId: "test",
  modelId: "mock",
  qualifiedId: "test:mock",
} as ModelInfo;

beforeEach(() => {
  storeManager.clearAll();
});

afterEach(() => {
  setLlmAdapterForTest(undefined);
  storeManager.clearAll();
});

function summary() {
  return {
    version: 1 as const,
    childBlockRefs: [],
    sections: {
      "Current Objective": "Continue the current task",
      "User Constraints": "Preserve user constraints",
      "Decisions Made": "Compression selected a safe prefix",
      "Open Tasks": "Continue from visible tail",
      "Important Files": "packages/agent-core/src/compression/resilience.test.ts",
      "Tool Results": "None",
      "Errors/Unknown Results": "None",
      "Protected Refs": "None",
      "Child Block Refs": "None",
      "Resume Instructions": "Resume after the compression block",
    },
  };
}

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
  const store = storeManager.create(sessionId);
  store.setState({ messages: compactableMessages() });
  return store;
}

function sessionFileFixture(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    createdAt: 1,
    agentName: "orchestrator",
    title: null,
    messages: [],
    steps: [],
    stats: createEmptySessionStats(),
    executions: [],
    compression: createEmptyCompressionState(),
    todos: [],
    pendingInteractions: [],
    reminders: [],
    childSessionLinks: [],
    rootSessionId: "session-1",
    ...overrides,
  };
}

describe("compression resilience", () => {
  test("single-flight manual compression prevents duplicate concurrent block commits", async () => {
    let releaseSummary!: () => void;
    const generateText = mock(async () => {
      await new Promise<void>((resolve) => {
        releaseSummary = resolve;
      });
      return { text: "", toolCalls: [{ toolName: "compression_summary", input: summary() }] };
    });
    setLlmAdapterForTest({ generateText: generateText as never });
    const store = makeStore();
    const command = createCompactCommand(store, modelInfo);

    const first = command.handler({ store, modelInfo, logger: silentLogger });
    await waitUntil(() => releaseSummary !== undefined);
    const second = await command.handler({ store, modelInfo, logger: silentLogger });

    releaseSummary();
    const firstResult = await first;

    expect(firstResult.success).toBe(true);
    expect(second).toEqual({ success: false, message: "Compact already in progress" });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(store.getState().compression?.activeBlockRefs).toEqual(["b1"]);
    expect(store.getState().events.filter((event) => event.kind === "compression.block_committed")).toHaveLength(1);
  });

  test("abort during summary leaves no partial active compression block", async () => {
    const controller = new AbortController();
    let adapterAbortSignal: AbortSignal | undefined;
    const generateText = mock(async (options: { abortSignal?: AbortSignal }) => {
      adapterAbortSignal = options.abortSignal;
      expect(adapterAbortSignal).toBe(controller.signal);
      expect(adapterAbortSignal?.aborted).toBe(false);

      controller.abort(new DOMException("summary aborted", "AbortError"));
      expect(adapterAbortSignal?.aborted).toBe(true);
      throw new DOMException("summary aborted", "AbortError");
    });
    setLlmAdapterForTest({ generateText: generateText as never });
    const store = makeStore();

    const result = await prepareHardLimitCompression({
      storeState: store.getState(),
      model: modelInfo.model,
      abort: controller.signal,
      logger: silentLogger,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected abort failure path");
    expect(adapterAbortSignal).toBe(controller.signal);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result.reason).toContain("summary aborted");
    expect(result.state.activeBlockRefs).toEqual([]);
    expect(Object.keys(result.state.blocksByRef)).toEqual([]);
    expect(store.getState().compression?.activeBlockRefs).toEqual([]);
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
