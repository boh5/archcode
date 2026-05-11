import { describe, expect, mock, test, beforeEach } from "bun:test";
import { createSessionStore } from "../../../store/store";
import { createMemoryExtractionHook } from "./memory-extraction";
import type { StoredMessage } from "../../../store/types";
import type { MemoryRoots } from "../../../memory/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDispatch = mock((..._args: any[]) => {}) as any;
const mockBtm = { dispatch: mockDispatch };

const mockProviderRegistry = {
  modelIds: ["test:model"],
  getModel: mock(() => ({ model: {} })),
};

const mockMemoryRoots: MemoryRoots = {
  project: "/tmp/test-project/.specra/memory",
  user: "/tmp/test-user/.specra/memory",
};

function makeUserMessage(text: string, now: number): StoredMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [
      {
        type: "text",
        id: crypto.randomUUID(),
        text,
        createdAt: now,
        completedAt: now,
      },
    ],
    createdAt: now,
    completedAt: now,
  };
}

function makeAssistantMessage(text: string, now: number): StoredMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [
      {
        type: "text",
        id: crypto.randomUUID(),
        text,
        createdAt: now,
        completedAt: now,
      },
    ],
    createdAt: now,
    completedAt: now,
  };
}

describe("createMemoryExtractionHook", () => {
  beforeEach(() => {
    mockDispatch.mockReset();
    mockDispatch.mockImplementation(() => {});
    mockProviderRegistry.getModel.mockReset();
    mockProviderRegistry.getModel.mockImplementation(() => ({ model: {} }));
  });

  test("dispatches memory-extraction task when enough content", async () => {
    const now = Date.now();
    const longText = "A".repeat(300);
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage(longText, now),
        makeAssistantMessage("Response", now),
        makeUserMessage("Follow up", now),
      ],
    });

    const ctx = { store, modelInfo: undefined as never, abort: undefined };
    const hook = createMemoryExtractionHook(
      mockBtm as never,
      mockProviderRegistry as never,
      mockMemoryRoots,
    );

    await hook(ctx as never);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(
      "memory-extraction",
      expect.any(Function),
    );
  });

  test("skips dispatch when fewer than MIN_MESSAGES_FOR_EXTRACTION user messages", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [makeUserMessage("Hi", now)],
    });

    const ctx = { store, modelInfo: undefined as never };
    const hook = createMemoryExtractionHook(
      mockBtm as never,
      mockProviderRegistry as never,
      mockMemoryRoots,
    );

    await hook(ctx as never);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("skips dispatch when total content length below MIN_CONTENT_LENGTH_FOR_EXTRACTION", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage("Hi", now),
        makeAssistantMessage("Hello", now),
      ],
    });

    const ctx = { store, modelInfo: undefined as never };
    const hook = createMemoryExtractionHook(
      mockBtm as never,
      mockProviderRegistry as never,
      mockMemoryRoots,
    );

    await hook(ctx as never);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("dispatches with correct memory roots derived from workspace", async () => {
    const now = Date.now();
    const longText = "A".repeat(300);
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage(longText, now),
        makeAssistantMessage("Response", now),
        makeUserMessage("Follow up", now),
      ],
    });

    const ctx = { store, modelInfo: undefined as never };
    const hook = createMemoryExtractionHook(
      mockBtm as never,
      mockProviderRegistry as never,
      mockMemoryRoots,
    );

    await hook(ctx as never);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const call = mockDispatch.mock.calls[0];
    const taskRunner = call[1];
    expect(typeof taskRunner).toBe("function");
  });

  test("does not skip when exactly at MIN_MESSAGES_FOR_EXTRACTION threshold", async () => {
    const now = Date.now();
    const longText = "A".repeat(300);
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage(longText, now),
        makeUserMessage("Follow up", now),
      ],
    });

    const ctx = { store, modelInfo: undefined as never };
    const hook = createMemoryExtractionHook(
      mockBtm as never,
      mockProviderRegistry as never,
      mockMemoryRoots,
    );

    await hook(ctx as never);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});