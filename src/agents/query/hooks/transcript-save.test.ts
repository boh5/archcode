import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createSessionStore } from "../../../store/store";
import type { StoredMessage, StoredTodo, StepInfo } from "../../../store/types";

const mockSaveSessionTranscript = mock(() => Promise.resolve());
const mockGetSessionsDir = mock(() => "/tmp/.specra/sessions");

mock.module("../../../store/helpers", () => ({
  saveSessionTranscript: mockSaveSessionTranscript,
}));

mock.module("../../../store/sessions-dir", () => ({
  getSessionsDir: mockGetSessionsDir,
}));

import { createTranscriptSaveHook } from "./transcript-save";

describe("createTranscriptSaveHook", () => {
  beforeEach(() => {
    mockSaveSessionTranscript.mockReset();
    mockSaveSessionTranscript.mockImplementation(() => Promise.resolve());
    mockGetSessionsDir.mockReset();
    mockGetSessionsDir.mockImplementation(() => "/tmp/.specra/sessions");
  });

  test("reads store state and calls saveSessionTranscript with correct fields", async () => {
    const now = Date.now();
    const sessionId = crypto.randomUUID();
    const store = createSessionStore(sessionId);

    const messages: StoredMessage[] = [
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [
          {
            type: "text",
            id: crypto.randomUUID(),
            text: "Hello",
            createdAt: now,
            completedAt: now,
          },
        ],
        createdAt: now,
        completedAt: now,
      },
    ];

    const steps: StepInfo[] = [
      {
        id: crypto.randomUUID(),
        step: 0,
        startedAt: now,
        completedAt: now,
        finishReason: "stop",
      },
    ];

    const todos: StoredTodo[] = [
      {
        id: crypto.randomUUID(),
        content: "Test todo",
        status: "pending",
        createdAt: now,
      },
    ];

    store.setState({
      sessionId,
      createdAt: now,
      messages,
      steps,
      todos,
    });

    const ctx = {
      store,
      modelInfo: undefined as never,
    };

    await createTranscriptSaveHook()(ctx as never);

    expect(mockSaveSessionTranscript).toHaveBeenCalledTimes(1);
    expect(mockSaveSessionTranscript).toHaveBeenCalledWith(
      {
        sessionId,
        createdAt: now,
        messages,
        steps,
        todos,
      },
      "/tmp/.specra/sessions",
    );
  });

  test("handles saveSessionTranscript errors gracefully (logs warning, does not throw)", async () => {
    const store = createSessionStore(crypto.randomUUID());
    const expectedError = new Error("Disk full");

    mockSaveSessionTranscript.mockRejectedValue(expectedError);

    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const ctx = { store, modelInfo: undefined as never };

      await expect(
        createTranscriptSaveHook()(ctx as never),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "Transcript save hook failed:",
        "Disk full",
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test("accesses sessionId, createdAt, messages, steps, todos from store (not from context)", async () => {
    const sessionId = crypto.randomUUID();
    const createdAt = Date.now();
    const store = createSessionStore(sessionId);

    store.setState({
      sessionId,
      createdAt,
      messages: [],
      steps: [],
      todos: [],
    });

    const ctx = {
      store,
      modelInfo: undefined as never,
    };

    await createTranscriptSaveHook()(ctx as never);

    expect(mockSaveSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        createdAt,
        messages: [],
        steps: [],
        todos: [],
      }),
      expect.any(String),
    );
  });
});
