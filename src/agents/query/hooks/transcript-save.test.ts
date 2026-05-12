import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createMockStore } from "../../../store/test-helpers";
import type { StoredMessage, StoredTodo, StepInfo } from "../../../store/types";

const TEST_TMP = join(import.meta.dir, "__test_tmp__", "transcript-save");

import { createTranscriptSaveHook } from "./transcript-save";

describe("createTranscriptSaveHook", () => {
  beforeAll(async () => {
    await mkdir(TEST_TMP, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
  });

  test("reads store state and saves transcript with correct fields", async () => {
    const now = Date.now();
    const sessionId = crypto.randomUUID();
    const store = createMockStore({ sessionId });

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

    await createTranscriptSaveHook(TEST_TMP)(ctx as never);

    const filePath = join(TEST_TMP, `${sessionId}.json`);
    const file = Bun.file(filePath);
    expect(await file.exists()).toBe(true);

    const content = JSON.parse(await file.text());
    expect(content.sessionId).toBe(sessionId);
    expect(content.createdAt).toBe(now);
    expect(content.messages).toHaveLength(1);
    expect(content.steps).toHaveLength(1);
    expect(content.todos).toHaveLength(1);
  });

  test("handles save errors gracefully (logs warning, does not throw)", async () => {
    const store = createMockStore();

    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const ctx = { store, modelInfo: undefined as never };

      const BAD_DIR = "/nonexistent/path/that/cannot/be/created/by/normal/user";

      await expect(
        createTranscriptSaveHook(BAD_DIR)(ctx as never),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "Transcript save hook failed:",
        expect.any(String),
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test("accesses sessionId, createdAt, messages, steps, todos from store (not from context)", async () => {
    const sessionId = crypto.randomUUID();
    const createdAt = Date.now();
    const store = createMockStore({ sessionId });

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

    await createTranscriptSaveHook(TEST_TMP)(ctx as never);

    const filePath = join(TEST_TMP, `${sessionId}.json`);
    const file = Bun.file(filePath);
    expect(await file.exists()).toBe(true);

    const content = JSON.parse(await file.text());
    expect(content.sessionId).toBe(sessionId);
    expect(content.createdAt).toBe(createdAt);
    expect(content.messages).toHaveLength(0);
    expect(content.steps).toHaveLength(0);
    expect(content.todos).toHaveLength(0);
  });
});
