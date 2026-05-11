import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createMockStore } from "./test-helpers";
import { getAssistantText, loadSessionTranscript, saveSessionTranscript } from "./helpers";
import type { Reminder, SessionStoreState, StepInfo, StoredMessage, StoredPart, StoredTodo } from "./types";

const TMP_DIR = join(import.meta.dir, "__test_tmp__");

afterAll(() => rm(TMP_DIR, { recursive: true, force: true }));

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

function uniqueSessionId(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

function sessionFilePath(sessionId: string): string {
  return join(TMP_DIR, `${sessionId}.json`);
}

async function writeSessionFile(sessionId: string, data: unknown): Promise<void> {
  await Bun.write(
    sessionFilePath(sessionId),
    JSON.stringify(
      data,
      (_key, value: unknown) => {
        if (value instanceof Set) return Array.from(value);
        if (value instanceof Map) return Array.from(value.entries());
        return value;
      },
      2,
    ),
  );
}

function textPart(id: string, text: string, completedAt?: number): StoredPart {
  return completedAt === undefined
    ? { type: "text", id, text, createdAt: 100 }
    : { type: "text", id, text, createdAt: 100, completedAt };
}

function sampleMessages(): StoredMessage[] {
  return [
    {
      id: "user-1",
      role: "user",
      parts: [textPart("user-text-1", "hello", 101)],
      createdAt: 100,
      completedAt: 101,
      runId: "run-1",
    },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [textPart("assistant-text-1", "world", 103)],
      createdAt: 102,
      completedAt: 104,
      runId: "run-1",
    },
  ];
}

function allPartVariantsMessage(): StoredMessage {
  return {
    id: "assistant-all-parts",
    role: "assistant",
    createdAt: 200,
    completedAt: 220,
    runId: "run-all",
    parts: [
      { type: "text", id: "text-complete", text: "done", createdAt: 201, completedAt: 202 },
      { type: "text", id: "text-incomplete", text: "streaming", createdAt: 203 },
      { type: "reasoning", id: "reasoning-complete", text: "because", createdAt: 204, completedAt: 205 },
      { type: "tool", state: "pending", id: "tool-pending", toolCallId: "call-pending", toolName: "read", createdAt: 206 },
      { type: "tool", state: "running", id: "tool-running", toolCallId: "call-running", toolName: "bash", input: { cmd: "pwd" }, createdAt: 207, startedAt: 208 },
      { type: "tool", state: "completed", id: "tool-completed", toolCallId: "call-completed", toolName: "write", input: { path: "a.ts" }, output: "ok", createdAt: 209, startedAt: 210, endedAt: 211 },
      { type: "tool", state: "error", id: "tool-error", toolCallId: "call-error", toolName: "edit", input: "bad", errorMessage: "failed", createdAt: 212, startedAt: 213, endedAt: 214 },
    ],
  };
}

function sampleSteps(): StepInfo[] {
  return [
    {
      id: "step-1",
      step: 1,
      runId: "run-1",
      startedAt: 300,
      completedAt: 310,
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2 },
    },
  ];
}

function sampleTodos(): StoredTodo[] {
  return [
    { id: "todo-1", content: "first", status: "completed", createdAt: 400, updatedAt: 410 },
    { id: "todo-2", content: "second", status: "in_progress", createdAt: 420 },
  ];
}

function sampleReminders(): Reminder[] {
  return [
    {
      id: "reminder-1",
      source: {
        type: "todo_continuation",
        pendingTodos: [{ id: "pending-todo", content: "resume this", status: "pending", createdAt: 500 }],
      },
      delivery: "auto_inject",
      content: "Continue pending todo",
      payload: { reason: "test" },
      createdAt: 600,
      consumedAt: null,
      targetSessionId: "target-session",
    },
    {
      id: "reminder-2",
      source: { type: "subagent_completed", sessionId: "child-1" },
      delivery: "on_demand",
      sessionId: "parent-session",
      terminalState: "done",
      content: "Child completed",
      createdAt: 610,
      consumedAt: 620,
    },
  ];
}

type PersistedSessionState = Pick<
  SessionStoreState,
  | "sessionId"
  | "createdAt"
  | "title"
  | "messages"
  | "steps"
  | "todos"
  | "reminders"
  | "childSessionIds"
  | "parentSessionId"
  | "subAgentDescriptions"
>;

function persistedState(
  sessionId: string,
  messages = sampleMessages(),
  steps = sampleSteps(),
  todos = sampleTodos(),
  reminders: Reminder[] = [],
  childSessionIds = new Set<string>(),
  parentSessionId: string | undefined = undefined,
  subAgentDescriptions = new Map<string, string>(),
): PersistedSessionState {
  return {
    sessionId,
    createdAt: 99,
    title: null,
    messages,
    steps,
    todos,
    reminders,
    childSessionIds,
    parentSessionId,
    subAgentDescriptions,
  };
}

describe("session transcript serialization", () => {
  test("save/load roundtrips sessionId, createdAt, messages, steps, and todos", async () => {
    const sessionId = uniqueSessionId("roundtrip");
    const state = persistedState(sessionId);

    await saveSessionTranscript(state, TMP_DIR);
    const loaded = await loadSessionTranscript(sessionId, TMP_DIR);

    expect(loaded.getState().sessionId).toBe(sessionId);
    expect(loaded.getState().createdAt).toBe(state.createdAt);
    expect(loaded.getState().messages).toEqual(state.messages);
    expect(loaded.getState().steps).toEqual(state.steps);
    expect(loaded.getState().todos).toEqual(state.todos);
  });

  test("roundtrips completed text, incomplete text, reasoning, and all tool part variants", async () => {
    const sessionId = uniqueSessionId("part-variants");
    const messages = [allPartVariantsMessage()];

    await saveSessionTranscript(persistedState(sessionId, messages), TMP_DIR);
    const loaded = await loadSessionTranscript(sessionId, TMP_DIR);

    expect(loaded.getState().messages).toEqual(messages);
  });

  test("loaded store resets transient state to safe defaults", async () => {
    const sessionId = uniqueSessionId("safe-state");

    await saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const loaded = await loadSessionTranscript(sessionId, TMP_DIR);
    const state = loaded.getState();

    expect(state.isRunning).toBe(false);
    expect(state.isStreamingModel).toBe(false);
    expect(state.currentRunId).toBeUndefined();
    expect(state.currentAssistantMessageId).toBeUndefined();
    expect(state.streamingText).toBeUndefined();
    expect(state.streamingReasoning).toBeUndefined();
    expect(state.streamingTools).toEqual({});
  });

  test("load defaults missing todos to an empty list", async () => {
    const sessionId = uniqueSessionId("missing-todos");
    const { todos: _todos, ...legacyState } = persistedState(sessionId);
    await writeSessionFile(sessionId, legacyState);

    const loaded = await loadSessionTranscript(sessionId, TMP_DIR);

    expect(loaded.getState().todos).toEqual([]);
  });

  test("save/load roundtrips reminders", async () => {
    const sessionId = uniqueSessionId("reminders-roundtrip");
    const reminders = sampleReminders();

    await saveSessionTranscript(
      persistedState(sessionId, sampleMessages(), sampleSteps(), sampleTodos(), reminders),
      TMP_DIR,
    );
    const loaded = await loadSessionTranscript(sessionId, TMP_DIR);

    expect(loaded.getState().reminders).toEqual(reminders);
  });

  test("load defaults missing reminder persistence fields", async () => {
    const sessionId = uniqueSessionId("missing-reminder-fields");
    const {
      reminders: _reminders,
      childSessionIds: _childSessionIds,
      parentSessionId: _parentSessionId,
      subAgentDescriptions: _subAgentDescriptions,
      ...legacyState
    } = persistedState(sessionId);
    await writeSessionFile(sessionId, legacyState);

    const loaded = await loadSessionTranscript(sessionId, TMP_DIR);
    const state = loaded.getState();

    expect(state.reminders).toEqual([]);
    expect(state.childSessionIds).toEqual(new Set());
    expect(state.parentSessionId).toBeUndefined();
    expect(state.subAgentDescriptions).toEqual(new Map());
  });

  test("save/load serializes child session Set and sub-agent description Map", async () => {
    const sessionId = uniqueSessionId("set-map-roundtrip");
    const childSessionIds = new Set(["child-1", "child-2"]);
    const subAgentDescriptions = new Map([
      ["child-1", "QA agent"],
      ["child-2", "Reviewer agent"],
    ]);
    const state = persistedState(
      sessionId,
      sampleMessages(),
      sampleSteps(),
      sampleTodos(),
      sampleReminders(),
      childSessionIds,
      "parent-1",
      subAgentDescriptions,
    );

    await saveSessionTranscript(state, TMP_DIR);
    const raw = await Bun.file(sessionFilePath(sessionId)).text();
    const parsed: Record<string, unknown> = JSON.parse(raw);
    const loaded = await loadSessionTranscript(sessionId, TMP_DIR);

    expect(parsed.childSessionIds).toEqual(["child-1", "child-2"]);
    expect(parsed.subAgentDescriptions).toEqual([
      ["child-1", "QA agent"],
      ["child-2", "Reviewer agent"],
    ]);
    expect(loaded.getState().childSessionIds).toEqual(childSessionIds);
    expect(loaded.getState().subAgentDescriptions).toEqual(subAgentDescriptions);
    expect(loaded.getState().parentSessionId).toBe("parent-1");
  });

  test("loaded store preserves methods and can continue appending", async () => {
    const sessionId = uniqueSessionId("append-after-load");

    await saveSessionTranscript(persistedState(sessionId, [], []), TMP_DIR);
    const loaded = await loadSessionTranscript(sessionId, TMP_DIR);
    loaded.getState().append({ type: "run-start", runId: "run-after-load" });
    loaded.getState().append({ type: "user-message", content: "after load" });

    const state = loaded.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.role).toBe("user");
    expect(state.messages[0]?.runId).toBe("run-after-load");
  });

  test("atomic write leaves no temporary file behind", async () => {
    const sessionId = uniqueSessionId("atomic");

    await saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const files = await readdir(TMP_DIR);

    expect(files).toContain(`${sessionId}.json`);
    expect(files).not.toContain(`${sessionId}.json.tmp`);
  });

  test("load rejects corrupted JSON", async () => {
    const sessionId = uniqueSessionId("corrupted");
    await Bun.write(sessionFilePath(sessionId), "{not json");

    await expect(loadSessionTranscript(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects schema-invalid data", async () => {
    const sessionId = uniqueSessionId("schema-invalid");
    await writeSessionFile(sessionId, { sessionId, createdAt: "not-number", messages: [] });

    await expect(loadSessionTranscript(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects unknown top-level fields", async () => {
    const sessionId = uniqueSessionId("unknown-top");
    await writeSessionFile(sessionId, { ...persistedState(sessionId), extra: true });

    await expect(loadSessionTranscript(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects unknown message fields", async () => {
    const sessionId = uniqueSessionId("unknown-message");
    const [message] = sampleMessages();
    if (!message) throw new Error("Expected sample message");
    await writeSessionFile(sessionId, {
      sessionId,
      createdAt: 99,
      messages: [{ ...message, extra: true }],
      steps: [],
    });

    await expect(loadSessionTranscript(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects unknown part fields", async () => {
    const sessionId = uniqueSessionId("unknown-part");
    await writeSessionFile(sessionId, {
      sessionId,
      createdAt: 99,
      messages: [
        {
          id: "message",
          role: "assistant",
          createdAt: 1,
          parts: [{ type: "text", id: "part", text: "hello", createdAt: 2, completedAt: 3, extra: true }],
        },
      ],
      steps: [],
    });

    await expect(loadSessionTranscript(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects invalid tool state", async () => {
    const sessionId = uniqueSessionId("invalid-tool-state");
    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      messages: [
        {
          id: "message",
          role: "assistant",
          createdAt: 1,
          parts: [{ type: "tool", state: "paused", id: "tool", toolCallId: "call", toolName: "read", createdAt: 2 }],
        },
      ],
    });

    await expect(loadSessionTranscript(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects invalid todo status", async () => {
    const sessionId = uniqueSessionId("invalid-todo-status");
    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      todos: [{ id: "todo", content: "bad", status: "blocked" }],
    });

    await expect(loadSessionTranscript(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects more than one in_progress todo", async () => {
    const sessionId = uniqueSessionId("multiple-in-progress-todos");
    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      todos: [
        { id: "todo-1", content: "one", status: "in_progress" },
        { id: "todo-2", content: "two", status: "in_progress" },
      ],
    });

    await expect(loadSessionTranscript(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects unknown todo fields", async () => {
    const sessionId = uniqueSessionId("unknown-todo-field");
    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      todos: [{ id: "todo", content: "bad", status: "pending", extra: true }],
    });

    await expect(loadSessionTranscript(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects sessionId mismatch", async () => {
    const requestedSessionId = uniqueSessionId("requested");
    await writeSessionFile(requestedSessionId, persistedState("different-session"));

    await expect(loadSessionTranscript(requestedSessionId, TMP_DIR)).rejects.toThrow("Session ID mismatch");
  });

  test("load rejects invalid role", async () => {
    const sessionId = uniqueSessionId("invalid-role");
    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      messages: [{ id: "message", role: "system", parts: [], createdAt: 1 }],
    });

    await expect(loadSessionTranscript(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects missing required timestamps", async () => {
    const sessionId = uniqueSessionId("missing-timestamp");
    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      messages: [{ id: "message", role: "assistant", parts: [{ type: "text", id: "part", text: "hello", completedAt: 2 }] }],
    });

    await expect(loadSessionTranscript(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("loaded store's toModelMessages works with loaded messages", async () => {
    const sessionId = uniqueSessionId("model-messages");
    const messages: StoredMessage[] = [
      {
        id: "user",
        role: "user",
        createdAt: 1,
        completedAt: 2,
        parts: [{ type: "text", id: "user-text", text: "hello", createdAt: 1, completedAt: 2 }],
      },
      {
        id: "assistant",
        role: "assistant",
        createdAt: 3,
        completedAt: 8,
        parts: [
          { type: "text", id: "assistant-text", text: "hi", createdAt: 4, completedAt: 5 },
          { type: "tool", state: "completed", id: "tool", toolCallId: "call", toolName: "read", input: { path: "a" }, output: "content", createdAt: 5, startedAt: 6, endedAt: 7 },
        ],
      },
    ];

    await saveSessionTranscript(persistedState(sessionId, messages, []), TMP_DIR);
    const loaded = await loadSessionTranscript(sessionId, TMP_DIR);

    expect(loaded.getState().toModelMessages()).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "tool-call", toolCallId: "call", toolName: "read", input: { path: "a" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call", toolName: "read", output: { type: "text", value: "content" } }] },
    ]);
  });

  test("save writes the new session file shape", async () => {
    const sessionId = uniqueSessionId("shape");

    await saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const raw = await Bun.file(sessionFilePath(sessionId)).text();
    const parsed: Record<string, unknown> = JSON.parse(raw);

    expect(Object.keys(parsed).sort()).toEqual([
      "childSessionIds",
      "createdAt",
      "messages",
      "reminders",
      "sessionId",
      "steps",
      "subAgentDescriptions",
      "title",
      "todos",
    ]);
    expect("events" in parsed).toBe(false);
    expect(parsed.todos).toEqual(sampleTodos());
    expect(parsed.reminders).toEqual([]);
    expect(parsed.childSessionIds).toEqual([]);
    expect(parsed.subAgentDescriptions).toEqual([]);
  });

  test("loadSessionTranscript resets all runtime-only fields", async () => {
    const sessionId = uniqueSessionId("runtime-fields");

    await saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const loaded = await loadSessionTranscript(sessionId, TMP_DIR);
    const state = loaded.getState();

    expect(state.isRunning).toBe(false);
    expect(state.isStreamingModel).toBe(false);
    expect(state.streamingText).toBeUndefined();
    expect(state.streamingReasoning).toBeUndefined();
    expect(state.streamingTools).toEqual({});
    expect(state.currentRunId).toBeUndefined();
    expect(state.currentAssistantMessageId).toBeUndefined();
  });

  test("loadSessionTranscript preserves persistent fields", async () => {
    const sessionId = uniqueSessionId("persistent-fields");
    const originalMessages = sampleMessages();
    const originalSteps = sampleSteps();
    const originalTodos = sampleTodos();

    await saveSessionTranscript(
      persistedState(sessionId, originalMessages, originalSteps, originalTodos),
      TMP_DIR,
    );
    const loaded = await loadSessionTranscript(sessionId, TMP_DIR);
    const loadedState = loaded.getState();

    expect(loadedState.sessionId).toBe(sessionId);
    expect(loadedState.createdAt).toBe(99);
    expect(loadedState.messages).toEqual(originalMessages);
    expect(loadedState.steps).toEqual(originalSteps);
    expect(loadedState.todos).toEqual(originalTodos);
  });

  test("load rejects unknown reminder fields", async () => {
    const sessionId = uniqueSessionId("unknown-reminder-field");
    const [reminder] = sampleReminders();
    if (!reminder) throw new Error("Expected sample reminder");

    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      reminders: [{ ...reminder, extra: true }],
    });

    await expect(loadSessionTranscript(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects unknown reminder source fields", async () => {
    const sessionId = uniqueSessionId("unknown-reminder-source-field");
    const [reminder] = sampleReminders();
    if (!reminder) throw new Error("Expected sample reminder");

    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      reminders: [
        {
          ...reminder,
          source: { ...reminder.source, extra: true },
        },
      ],
    });

    await expect(loadSessionTranscript(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("append works after load", async () => {
    const sessionId = uniqueSessionId("append-after-load-v2");

    await saveSessionTranscript(persistedState(sessionId, [], []), TMP_DIR);
    const loaded = await loadSessionTranscript(sessionId, TMP_DIR);
    loaded.getState().append({ type: "run-start", runId: "append-work-run" });
    loaded.getState().append({ type: "user-message", content: "appended after load" });

    const state = loaded.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.role).toBe("user");
    expect(state.messages[0]?.runId).toBe("append-work-run");
  });

  test("loadSessionTranscript resets readSnapshots to empty Map", async () => {
    const sessionId = uniqueSessionId("read-snapshots");

    const store = createMockStore({ readSnapshots: new Map([["file.ts", 456]]) });

    await saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const loaded = await loadSessionTranscript(sessionId, TMP_DIR);

    expect(loaded.getState().readSnapshots.size).toBe(0);
  });
});

describe("getAssistantText", () => {
  test("returns empty string for no messages", () => {
    expect(getAssistantText([])).toBe("");
  });

  test("concatenates completed assistant text in message and part order", () => {
    const messages: StoredMessage[] = [
      { id: "a", role: "assistant", createdAt: 1, parts: [textPart("a1", "hel", 2), textPart("a2", "lo", 3)] },
      { id: "b", role: "assistant", createdAt: 4, parts: [textPart("b1", " world", 5)] },
    ];

    expect(getAssistantText(messages)).toBe("hello world");
  });

  test("ignores user text", () => {
    const messages: StoredMessage[] = [
      { id: "user", role: "user", createdAt: 1, parts: [textPart("user-text", "ignore", 2)] },
      { id: "assistant", role: "assistant", createdAt: 3, parts: [textPart("assistant-text", "keep", 4)] },
    ];

    expect(getAssistantText(messages)).toBe("keep");
  });

  test("ignores incomplete assistant text", () => {
    const messages: StoredMessage[] = [
      { id: "assistant", role: "assistant", createdAt: 1, parts: [textPart("incomplete", "ignore"), textPart("complete", "keep", 2)] },
    ];

    expect(getAssistantText(messages)).toBe("keep");
  });

  test("ignores reasoning and tool parts", () => {
    const messages: StoredMessage[] = [allPartVariantsMessage()];

    expect(getAssistantText(messages)).toBe("done");
  });
});

describe("saveSessionTranscript error handling", () => {
  test("throws on readonly directory", async () => {
    const sessionId = uniqueSessionId("readonly-save");
    const readonlyDir = join(TMP_DIR, "readonly-save-test");
    await mkdir(readonlyDir, { recursive: true });
    await chmod(readonlyDir, 0o444);

    try {
      await expect(
        saveSessionTranscript(persistedState(sessionId), readonlyDir),
      ).rejects.toThrow();
    } finally {
      await chmod(readonlyDir, 0o755).catch(() => {});
      await rm(readonlyDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("throws on invalid path", async () => {
    const sessionId = uniqueSessionId("invalid-path-save");

    await expect(
      saveSessionTranscript(persistedState(sessionId), "/dev/null/impossible"),
    ).rejects.toThrow();
  });

  test("error messages contain useful context about the path", async () => {
    const sessionId = uniqueSessionId("error-context");
    const readonlyDir = join(TMP_DIR, "error-context-test");
    await mkdir(readonlyDir, { recursive: true });
    await chmod(readonlyDir, 0o444);

    try {
      const error = await saveSessionTranscript(
        persistedState(sessionId),
        readonlyDir,
      ).catch((e: unknown) => e as Error);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(readonlyDir);
    } finally {
      await chmod(readonlyDir, 0o755).catch(() => {});
      await rm(readonlyDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
