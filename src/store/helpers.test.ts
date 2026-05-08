import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAssistantText, loadSessionTranscript, saveSessionTranscript } from "./helpers";
import type { SessionStoreState, StepInfo, StoredMessage, StoredPart, StoredTodo } from "./types";

const TMP_DIR = join(import.meta.dir, "__test_tmp__");

afterAll(() => rm(TMP_DIR, { recursive: true, force: true }));

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

function uniqueSessionId(label: string): string {
  return `${label}-${randomUUID()}`;
}

function sessionFilePath(sessionId: string): string {
  return join(TMP_DIR, `${sessionId}.json`);
}

async function writeSessionFile(sessionId: string, data: unknown): Promise<void> {
  await writeFile(sessionFilePath(sessionId), JSON.stringify(data, null, 2), "utf-8");
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

function persistedState(sessionId: string, messages = sampleMessages(), steps = sampleSteps(), todos = sampleTodos()): Pick<SessionStoreState, "sessionId" | "createdAt" | "messages" | "steps" | "todos"> {
  return { sessionId, createdAt: 99, messages, steps, todos };
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
    await writeFile(sessionFilePath(sessionId), "{not json", "utf-8");

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
    const raw = await readFile(sessionFilePath(sessionId), "utf-8");
    const parsed: Record<string, unknown> = JSON.parse(raw);

    expect(Object.keys(parsed).sort()).toEqual(["createdAt", "messages", "sessionId", "steps", "todos"]);
    expect("events" in parsed).toBe(false);
    expect(parsed.todos).toEqual(sampleTodos());
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
