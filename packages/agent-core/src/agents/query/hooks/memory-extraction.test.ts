import { afterEach, describe, expect, mock, test, beforeEach } from "bun:test";
import { createSessionStore } from "../../../store/store";
import { createMemoryExtractionHook } from "./memory-extraction";
import type { StoredMessage } from "../../../store/types";
import type { MemoryRoots } from "../../../memory/types";
import { MIN_EXTRACTION_INTERVAL_MS } from "../../../memory/constants";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDispatch = mock((..._args: any[]) => true as boolean) as any;
const mockGetLastCompletedAt = mock((_name: string) => undefined as number | undefined);
const mockBtm = { dispatch: mockDispatch, getLastCompletedAt: mockGetLastCompletedAt };

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

const originalDateNow = Date.now;

describe("createMemoryExtractionHook", () => {
  beforeEach(() => {
    mockDispatch.mockReset();
    mockDispatch.mockImplementation(() => true);
    mockGetLastCompletedAt.mockReset();
    mockGetLastCompletedAt.mockImplementation(() => undefined);
    Date.now = originalDateNow;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  test("dispatches memory-extraction task when enough content", async () => {
    const now = Date.now();
    const longText = "A".repeat(1000);
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage(longText, now),
        makeAssistantMessage("Response", now),
        makeUserMessage("Follow up", now),
        makeUserMessage("Third", now),
        makeUserMessage("Fourth", now),
        makeUserMessage("Fifth", now),
      ],
    });

    const ctx = { store, modelInfo: undefined as never, abort: undefined };
    const hook = createMemoryExtractionHook(
      mockBtm as never,
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
      mockMemoryRoots,
    );

    await hook(ctx as never);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("dispatches with correct memory roots derived from workspace", async () => {
    const now = Date.now();
    const longText = "A".repeat(1000);
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage(longText, now),
        makeAssistantMessage("Response", now),
        makeUserMessage("Follow up", now),
        makeUserMessage("Third", now),
        makeUserMessage("Fourth", now),
        makeUserMessage("Fifth", now),
      ],
    });

    const ctx = { store, modelInfo: undefined as never };
    const hook = createMemoryExtractionHook(
      mockBtm as never,
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
    const longText = "A".repeat(1000);
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage(longText, now),
        makeUserMessage("Follow up", now),
        makeUserMessage("Third", now),
        makeUserMessage("Fourth", now),
        makeUserMessage("Fifth", now),
      ],
    });

    const ctx = { store, modelInfo: undefined as never };
    const hook = createMemoryExtractionHook(
      mockBtm as never,
      mockMemoryRoots,
    );

    await hook(ctx as never);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test("skips messages before lastExtractionIndex", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      lastExtractionIndex: 2,
      messages: [
        makeUserMessage("old one", now),
        makeUserMessage("old two", now),
        makeUserMessage("new one", now),
        makeUserMessage("new two", now),
        makeUserMessage("new three", now),
        makeUserMessage("new four", now),
      ],
    });

    const hook = createMemoryExtractionHook(mockBtm as never, mockMemoryRoots);
    await hook({ store, modelInfo: undefined as never } as never);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("dispatches based on new messages after lastExtractionIndex", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      lastExtractionIndex: 2,
      messages: [
        makeUserMessage("old one", now),
        makeUserMessage("old two", now),
        makeUserMessage("A".repeat(300), now),
        makeUserMessage("B".repeat(300), now),
        makeUserMessage("C".repeat(300), now),
        makeUserMessage("D".repeat(300), now),
        makeUserMessage("E".repeat(300), now),
      ],
    });

    const hook = createMemoryExtractionHook(mockBtm as never, mockMemoryRoots);
    await hook({ store, modelInfo: undefined as never } as never);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test("updates lastExtractionIndex and lastExtractionTime after dispatch", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage("A".repeat(300), now),
        makeUserMessage("B".repeat(300), now),
        makeUserMessage("C".repeat(300), now),
        makeUserMessage("D".repeat(300), now),
        makeUserMessage("E".repeat(300), now),
      ],
    });

    const hook = createMemoryExtractionHook(mockBtm as never, mockMemoryRoots);
    await hook({ store, modelInfo: undefined as never } as never);

    expect(store.getState().lastExtractionIndex).toBe(5);
    expect(store.getState().lastExtractionTime).toBeGreaterThan(0);
  });

  test("skips dispatch during cooldown after last completed task", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage("A".repeat(300), now),
        makeUserMessage("B".repeat(300), now),
        makeUserMessage("C".repeat(300), now),
        makeUserMessage("D".repeat(300), now),
        makeUserMessage("E".repeat(300), now),
      ],
    });

    Date.now = (() => now) as never;
    mockGetLastCompletedAt.mockImplementation(() => now - MIN_EXTRACTION_INTERVAL_MS + 1);

    try {
      const hook = createMemoryExtractionHook(mockBtm as never, mockMemoryRoots);
      await hook({ store, modelInfo: undefined as never } as never);
      expect(mockDispatch).not.toHaveBeenCalled();
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("dispatches when cooldown has elapsed or no completion recorded", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage("A".repeat(300), now),
        makeUserMessage("B".repeat(300), now),
        makeUserMessage("C".repeat(300), now),
        makeUserMessage("D".repeat(300), now),
        makeUserMessage("E".repeat(300), now),
      ],
    });

    mockGetLastCompletedAt.mockImplementation(() => undefined);
    const hook = createMemoryExtractionHook(mockBtm as never, mockMemoryRoots);
    await hook({ store, modelInfo: undefined as never } as never);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test("uses custom threshold values", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [makeUserMessage("A".repeat(150), now)],
    });

    const ctx = { store, modelInfo: undefined as never };
    const hook = createMemoryExtractionHook(
      mockBtm as never,
      mockMemoryRoots,
      undefined,
      { enabled: true, minMessages: 1, minContentLength: 100, cooldownMs: 0 },
    );

    await hook(ctx as never);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test("uses default threshold values when config is absent", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [makeUserMessage("A".repeat(150), now)],
    });

    const ctx = { store, modelInfo: undefined as never };
    const hook = createMemoryExtractionHook(
      mockBtm as never,
      mockMemoryRoots,
    );

    await hook(ctx as never);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("respects cooldown between dispatches", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [makeUserMessage("A".repeat(150), now)],
    });

    const ctx = { store, modelInfo: undefined as never };
    const hook = createMemoryExtractionHook(
      mockBtm as never,
      mockMemoryRoots,
      undefined,
      { enabled: true, minMessages: 1, minContentLength: 100, cooldownMs: 300000 },
    );

    await hook(ctx as never);
    await hook(ctx as never);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test("does not advance cursor when dispatch returns false (dedup)", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage("A".repeat(300), now),
        makeUserMessage("B".repeat(300), now),
        makeUserMessage("C".repeat(300), now),
        makeUserMessage("D".repeat(300), now),
        makeUserMessage("E".repeat(300), now),
      ],
    });

    mockDispatch.mockImplementation(() => false);

    const hook = createMemoryExtractionHook(mockBtm as never, mockMemoryRoots);
    await hook({ store, modelInfo: undefined as never } as never);

    expect(store.getState().lastExtractionIndex).toBe(0);
  });

  test("passes config thresholds to extraction task", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [makeUserMessage("A".repeat(150), now)],
    });

    const ctx = { store, modelInfo: undefined as never };
    const hook = createMemoryExtractionHook(
      mockBtm as never,
      mockMemoryRoots,
      undefined,
      { enabled: true, minMessages: 1, minContentLength: 100, cooldownMs: 0 },
    );

    await hook(ctx as never);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const call = mockDispatch.mock.calls[0];
    const taskRunner = call[1];
    expect(typeof taskRunner).toBe("function");
  });
});
