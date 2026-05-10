import { describe, expect, test } from "bun:test";
import { toModelMessagesFromStoredMessages } from "./projection";
import type { Reminder, StoredMessage, StoredPart } from "./types";
import { REDACTION_MARKER } from "../tools/hooks/redact";

let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function textPart(text: string, completed = true): StoredPart {
  return {
    type: "text",
    id: nextId("text"),
    text,
    createdAt: idCounter,
    ...(completed ? { completedAt: idCounter + 1 } : {}),
  };
}

function reasoningPart(text: string, completed = true): StoredPart {
  return {
    type: "reasoning",
    id: nextId("reasoning"),
    text,
    createdAt: idCounter,
    ...(completed ? { completedAt: idCounter + 1 } : {}),
  };
}

function completedToolPart(options: {
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: string;
} = {}): StoredPart {
  return {
    type: "tool",
    id: nextId("tool"),
    state: "completed",
    toolCallId: options.toolCallId ?? nextId("call"),
    toolName: options.toolName ?? "read_file",
    input: options.input ?? { path: "README.md" },
    output: options.output ?? "file content",
    createdAt: idCounter,
    startedAt: idCounter + 1,
    endedAt: idCounter + 2,
  };
}

function errorToolPart(options: {
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  errorMessage?: string;
} = {}): StoredPart {
  return {
    type: "tool",
    id: nextId("tool"),
    state: "error",
    toolCallId: options.toolCallId ?? nextId("call"),
    toolName: options.toolName ?? "write_file",
    input: options.input ?? { path: "missing.txt" },
    errorMessage: options.errorMessage ?? "permission denied",
    createdAt: idCounter,
    startedAt: idCounter + 1,
    endedAt: idCounter + 2,
  };
}

function pendingToolPart(): StoredPart {
  return {
    type: "tool",
    id: nextId("tool"),
    state: "pending",
    toolCallId: nextId("call"),
    toolName: "search",
    createdAt: idCounter,
  };
}

function runningToolPart(): StoredPart {
  return {
    type: "tool",
    id: nextId("tool"),
    state: "running",
    toolCallId: nextId("call"),
    toolName: "search",
    input: { query: "specra" },
    createdAt: idCounter,
    startedAt: idCounter + 1,
  };
}

function storedMessage(role: StoredMessage["role"], parts: StoredPart[]): StoredMessage {
  return {
    id: nextId("message"),
    role,
    parts,
    createdAt: idCounter,
    completedAt: idCounter + 1,
  };
}

function reminder(options: {
  id?: string;
  delivery?: Reminder["delivery"];
  content?: string;
  createdAt?: number;
  consumedAt?: number | null;
} = {}): Reminder {
  return {
    id: options.id ?? nextId("reminder"),
    source: { type: "todo_continuation", pendingTodos: [] },
    delivery: options.delivery ?? "auto_inject",
    content: options.content ?? "Remember the constraint.",
    createdAt: options.createdAt ?? idCounter,
    consumedAt: options.consumedAt ?? null,
  };
}

describe("toModelMessagesFromStoredMessages", () => {
  test("returns empty ModelMessage array for empty stored messages", () => {
    expect(toModelMessagesFromStoredMessages([])).toEqual([]);
  });

  test("returns the same projection when reminders are omitted", () => {
    const messages = [storedMessage("user", [textPart("hello")])];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  test("returns the same projection when reminders are empty", () => {
    const messages = [storedMessage("user", [textPart("hello")])];

    expect(toModelMessagesFromStoredMessages(messages, [])).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  test("has no todo-specific projection path", () => {
    expect(toModelMessagesFromStoredMessages([])).toEqual([]);
    expect(JSON.stringify(toModelMessagesFromStoredMessages([]))).not.toContain("todo");
  });

  test("projects a user message with completed text to a single user ModelMessage", () => {
    const messages = [storedMessage("user", [textPart("hello")])];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  test("concatenates multiple completed user text parts in order without a separator", () => {
    const messages = [storedMessage("user", [textPart("hello"), textPart(" world")])];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([
      { role: "user", content: "hello world" },
    ]);
  });

  test("omits a user message with only incomplete text", () => {
    const messages = [storedMessage("user", [textPart("draft", false)])];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([]);
  });

  test("filters incomplete user text while keeping completed user text", () => {
    const messages = [storedMessage("user", [textPart("keep"), textPart("skip", false)])];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([
      { role: "user", content: "keep" },
    ]);
  });

  test("projects an assistant message with completed text to assistant text content", () => {
    const messages = [storedMessage("assistant", [textPart("answer")])];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
  });

  test("omits an assistant message with incomplete text", () => {
    const messages = [storedMessage("assistant", [textPart("partial", false)])];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([]);
  });

  test("omits an assistant message with only incomplete parts", () => {
    const messages = [
      storedMessage("assistant", [textPart("partial", false), pendingToolPart(), runningToolPart()]),
    ];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([]);
  });

  test("preserves order for multiple completed assistant text parts", () => {
    const messages = [storedMessage("assistant", [textPart("first"), textPart(" second")])];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: " second" },
        ],
      },
    ]);
  });

  test("filters completed reasoning parts", () => {
    const messages = [storedMessage("assistant", [reasoningPart("hidden"), textPart("visible")])];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "visible" }] },
    ]);
  });

  test("filters incomplete reasoning parts", () => {
    const messages = [storedMessage("assistant", [reasoningPart("hidden", false), textPart("visible")])];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "visible" }] },
    ]);
  });

  test("omits an assistant message with only reasoning", () => {
    const messages = [storedMessage("assistant", [reasoningPart("hidden")])];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([]);
  });

  test("projects a completed tool part to assistant tool-call and tool result messages", () => {
    const messages = [
      storedMessage("assistant", [
        completedToolPart({
          toolCallId: "call-1",
          toolName: "read_file",
          input: { path: "a.txt" },
          output: "contents",
        }),
      ]),
    ];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "a.txt" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_file",
            output: { type: "text", value: "contents" },
          },
        ],
      },
    ]);
  });

  test("projects an error tool part to assistant tool-call and error-text tool result", () => {
    const messages = [
      storedMessage("assistant", [
        errorToolPart({
          toolCallId: "call-2",
          toolName: "write_file",
          input: { path: "a.txt" },
          errorMessage: "disk full",
        }),
      ]),
    ];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-2", toolName: "write_file", input: { path: "a.txt" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "write_file",
            output: { type: "error-text", value: "disk full" },
          },
        ],
      },
    ]);
  });

  test("filters pending tool parts", () => {
    const messages = [storedMessage("assistant", [pendingToolPart(), textPart("done")])];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
  });

  test("filters running tool parts", () => {
    const messages = [storedMessage("assistant", [runningToolPart(), textPart("done")])];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
  });

  test("tool projection uses input and never args", () => {
    const [projected] = toModelMessagesFromStoredMessages([
      storedMessage("assistant", [completedToolPart({ toolCallId: "call-3", input: { value: 42 } })]),
    ]);

    expect(projected).toEqual({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "call-3", toolName: "read_file", input: { value: 42 } },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain("args");
  });

  test("tool projection redacts secret-like input defensively", () => {
    const rawSecret = "sk_test_1234567890abcdef";
    const projected = toModelMessagesFromStoredMessages([
      storedMessage("assistant", [completedToolPart({ toolCallId: "call-secret", input: { command: `token=${rawSecret}` } })]),
    ]);

    expect(JSON.stringify(projected)).toContain(REDACTION_MARKER);
    expect(JSON.stringify(projected)).not.toContain(rawSecret);
  });

  test("successful tool result uses output text object and never isError", () => {
    const [, projected] = toModelMessagesFromStoredMessages([
      storedMessage("assistant", [completedToolPart({ toolCallId: "call-4", output: "ok" })]),
    ]);

    expect(projected).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-4",
          toolName: "read_file",
          output: { type: "text", value: "ok" },
        },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain("isError");
  });

  test("error tool result uses output error-text object", () => {
    const [, projected] = toModelMessagesFromStoredMessages([
      storedMessage("assistant", [errorToolPart({ toolCallId: "call-5", errorMessage: "boom" })]),
    ]);

    expect(projected).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-5",
          toolName: "write_file",
          output: { type: "error-text", value: "boom" },
        },
      ],
    });
  });

  test("projects mixed assistant parts in order with separate tool result message", () => {
    const messages = [
      storedMessage("assistant", [
        textPart("before"),
        completedToolPart({ toolCallId: "call-6", toolName: "read", input: { file: "a" }, output: "A" }),
        textPart("after"),
        errorToolPart({ toolCallId: "call-7", toolName: "write", input: { file: "b" }, errorMessage: "B" }),
      ]),
    ];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "tool-call", toolCallId: "call-6", toolName: "read", input: { file: "a" } },
          { type: "text", text: "after" },
          { type: "tool-call", toolCallId: "call-7", toolName: "write", input: { file: "b" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-6",
            toolName: "read",
            output: { type: "text", value: "A" },
          },
          {
            type: "tool-result",
            toolCallId: "call-7",
            toolName: "write",
            output: { type: "error-text", value: "B" },
          },
        ],
      },
    ]);
  });

  test("preserves message order across multiple stored messages", () => {
    const messages = [
      storedMessage("user", [textPart("one")]),
      storedMessage("assistant", [textPart("two")]),
      storedMessage("user", [textPart("three")]),
    ];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
      { role: "user", content: "three" },
    ]);
  });

  test("never returns empty assistant or tool messages", () => {
    const projected = toModelMessagesFromStoredMessages([
      storedMessage("assistant", [reasoningPart("hidden"), pendingToolPart(), runningToolPart()]),
      storedMessage("user", [textPart("", false)]),
    ]);

    expect(projected).toEqual([]);
  });

  test("projects a full conversation with user, assistant text, user, assistant tool, and tool result", () => {
    const messages = [
      storedMessage("user", [textPart("read the file")]),
      storedMessage("assistant", [textPart("I will read it.")]),
      storedMessage("user", [textPart("thanks")]),
      storedMessage("assistant", [
        completedToolPart({
          toolCallId: "call-8",
          toolName: "read_file",
          input: { path: "notes.md" },
          output: "notes",
        }),
      ]),
    ];

    expect(toModelMessagesFromStoredMessages(messages)).toEqual([
      { role: "user", content: "read the file" },
      { role: "assistant", content: [{ type: "text", text: "I will read it." }] },
      { role: "user", content: "thanks" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-8",
            toolName: "read_file",
            input: { path: "notes.md" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-8",
            toolName: "read_file",
            output: { type: "text", value: "notes" },
          },
        ],
      },
    ]);
  });

  test("appends one unconsumed auto-inject reminder as a synthetic user message", () => {
    const messages = [storedMessage("user", [textPart("hello")])];

    expect(
      toModelMessagesFromStoredMessages(messages, [
        reminder({ content: "Check the latest background task.", createdAt: 20 }),
      ]),
    ).toEqual([
      { role: "user", content: "hello" },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nCheck the latest background task.\n</system-reminder>",
          },
        ],
      },
    ]);
  });

  test("appends multiple auto-inject reminders ordered by createdAt", () => {
    expect(
      toModelMessagesFromStoredMessages([], [
        reminder({ id: "later", content: "Later reminder.", createdAt: 30 }),
        reminder({ id: "earlier", content: "Earlier reminder.", createdAt: 10 }),
        reminder({ id: "middle", content: "Middle reminder.", createdAt: 20 }),
      ]),
    ).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>\nEarlier reminder.\n</system-reminder>" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>\nMiddle reminder.\n</system-reminder>" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>\nLater reminder.\n</system-reminder>" }],
      },
    ]);
  });

  test("does not inject on-demand reminders", () => {
    expect(
      toModelMessagesFromStoredMessages([], [
        reminder({ delivery: "on_demand", content: "Wait for explicit demand.", createdAt: 10 }),
      ]),
    ).toEqual([]);
  });

  test("does not inject consumed auto-inject reminders", () => {
    expect(
      toModelMessagesFromStoredMessages([], [
        reminder({ content: "Already injected.", createdAt: 10, consumedAt: 11 }),
      ]),
    ).toEqual([]);
  });

  test("does not mutate input message or reminder arrays", () => {
    const messages = [storedMessage("user", [textPart("hello")])];
    const reminders = [
      reminder({ id: "later", content: "Later reminder.", createdAt: 30 }),
      reminder({ id: "earlier", content: "Earlier reminder.", createdAt: 10 }),
      reminder({ id: "consumed", content: "Consumed reminder.", createdAt: 20, consumedAt: 21 }),
    ];
    const originalMessages = structuredClone(messages);
    const originalReminders = structuredClone(reminders);

    toModelMessagesFromStoredMessages(messages, reminders);

    expect(messages).toEqual(originalMessages);
    expect(reminders).toEqual(originalReminders);
    expect(reminders.map((item) => item.id)).toEqual(["later", "earlier", "consumed"]);
  });
});
