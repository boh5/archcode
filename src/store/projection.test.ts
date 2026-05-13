import { describe, expect, test } from "bun:test";
import { toModelMessagesFromStoredMessages } from "./projection";
import type { CompactionPart, StoredMessage, StoredPart, SystemNoticePart } from "./types";
import { REDACTION_MARKER } from "../tools/security";

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
  meta?: Record<string, unknown>;
}): StoredPart {
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
    ...(options.meta ? { meta: options.meta } : {}),
  };
}

function errorToolPart(options: {
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  errorMessage?: string;
  meta?: Record<string, unknown>;
}): StoredPart {
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
    ...(options.meta ? { meta: options.meta } : {}),
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

function compactionPart(summary: string, tailStartId: string): CompactionPart {
  return {
    type: "compaction",
    id: nextId("compaction"),
    summary,
    tailStartId,
    compactedAt: idCounter,
  };
}

function systemNoticePart(notice: string): SystemNoticePart {
  return {
    type: "system-notice",
    id: nextId("notice"),
    notice,
    createdAt: idCounter,
    completedAt: idCounter + 1,
  };
}

function storedMessage(role: StoredMessage["role"], parts: StoredPart[], compacted?: boolean): StoredMessage {
  return {
    id: nextId("message"),
    role,
    parts,
    createdAt: idCounter,
    completedAt: idCounter + 1,
    ...(compacted ? { compacted: true } : {}),
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

  test("has no todo-specific projection path", () => {
    expect(toModelMessagesFromStoredMessages([])).toEqual([]);
    expect(JSON.stringify(toModelMessagesFromStoredMessages([]))).not.toContain("todo");
  });

  test("returns pure message projection with no reminder injection", () => {
    const messages = [storedMessage("user", [textPart("hello")])];

    const projected = toModelMessagesFromStoredMessages(messages);

    expect(projected).toEqual([{ role: "user", content: "hello" }]);
    expect(JSON.stringify(projected)).not.toContain("<system-reminder>");
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
});

describe("toModelMessagesFromStoredMessages compaction", () => {
  test("projection after compaction: summary + tail appear, old prefix excluded", () => {
    const tailMsg = storedMessage("user", [textPart("tail question")]);
    const tailAssistantMsg = storedMessage("assistant", [textPart("tail answer")]);

    const compactionMsg = storedMessage("user", [
      compactionPart("Summary of old conversation", tailMsg.id),
    ]);

    const prefixMsg = storedMessage("user", [textPart("old question")], true);
    const prefixAssistantMsg = storedMessage("assistant", [textPart("old answer")], true);

    const messages = [prefixMsg, prefixAssistantMsg, compactionMsg, tailMsg, tailAssistantMsg];

    const projected = toModelMessagesFromStoredMessages(messages);

    expect(projected).toEqual([
      { role: "user", content: "<compact-summary>\nSummary of old conversation\n</compact-summary>" },
      { role: "user", content: "tail question" },
      { role: "assistant", content: [{ type: "text", text: "tail answer" }] },
    ]);
  });

  test("full-history projection includes original compacted prefix and excludes CompactionPart", () => {
    const tailMsg = storedMessage("user", [textPart("tail question")]);
    const compactionMsg = storedMessage("user", [
      compactionPart("Summary of old conversation", tailMsg.id),
    ]);
    const prefixMsg = storedMessage("user", [textPart("old question")], true);
    const prefixAssistantMsg = storedMessage("assistant", [textPart("old answer")], true);

    const messages = [prefixMsg, prefixAssistantMsg, compactionMsg, tailMsg];

    const projected = toModelMessagesFromStoredMessages(messages, { mode: "full-history" });

    expect(projected).toEqual([
      { role: "user", content: "old question" },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: "tail question" },
    ]);
  });

  test("full-history projection excludes SystemNoticePart", () => {
    const messages = [
      storedMessage("user", [systemNoticePart("system notice here"), textPart("hello")]),
    ];

    const projected = toModelMessagesFromStoredMessages(messages, { mode: "full-history" });
    expect(projected).toEqual([{ role: "user", content: "hello" }]);
  });

  test("model mode skips SystemNoticePart in user messages", () => {
    const messages = [
      storedMessage("user", [systemNoticePart("system notice here"), textPart("hello")]),
    ];

    const projected = toModelMessagesFromStoredMessages(messages);
    expect(projected).toEqual([{ role: "user", content: "hello" }]);
  });

  test("model mode skips SystemNoticePart in assistant messages", () => {
    const messages = [
      storedMessage("assistant", [systemNoticePart("notice"), textPart("response")]),
    ];

    const projected = toModelMessagesFromStoredMessages(messages);
    expect(projected).toEqual([{ role: "assistant", content: [{ type: "text", text: "response" }] }]);
  });

  test("tool call/result pairs stay atomic at compaction boundary", () => {
    const tailMsg = storedMessage("user", [textPart("continuation")]);
    const compactionMsg = storedMessage("user", [
      compactionPart("Summary including tool call context", tailMsg.id),
    ]);

    const prefixUserMsg = storedMessage("user", [textPart("old question")], true);
    const prefixAssistantMsg = storedMessage("assistant", [
      completedToolPart({ toolCallId: "call-1", toolName: "read", input: { path: "a" }, output: "A" }),
    ], true);

    const messages = [prefixUserMsg, prefixAssistantMsg, compactionMsg, tailMsg];

    const projected = toModelMessagesFromStoredMessages(messages);

    expect(projected).toEqual([
      { role: "user", content: "<compact-summary>\nSummary including tool call context\n</compact-summary>" },
      { role: "user", content: "continuation" },
    ]);
  });

  test("multiple compactions in one session: second CompactionPart supersedes first", () => {
    const tailMsg2 = storedMessage("user", [textPart("second tail")]);
    const compactionMsg2 = storedMessage("user", [
      compactionPart("Second summary", tailMsg2.id),
    ]);

    const prefixMsg = storedMessage("user", [textPart("old question")], true);

    const messages = [prefixMsg, compactionMsg2, tailMsg2];

    const projected = toModelMessagesFromStoredMessages(messages);

    const summaryMessages = projected.filter(
      (m) => typeof m.content === "string" && m.content.includes("compact-summary"),
    );
    expect(summaryMessages).toHaveLength(1);
    expect(summaryMessages[0]!.content).toContain("Second summary");
  });

  test("user text containing literal <compact-summary> markers is not treated as compaction", () => {
    const messages = [
      storedMessage("user", [textPart("I typed <compact-summary> literally")]),
    ];

    const projected = toModelMessagesFromStoredMessages(messages);
    expect(projected).toEqual([{ role: "user", content: "I typed <compact-summary> literally" }]);
  });

  test("non-compacted sessions project identically to current behavior", () => {
    const messages = [
      storedMessage("user", [textPart("hello")]),
      storedMessage("assistant", [textPart("world")]),
      storedMessage("user", [textPart("how are you")]),
    ];

    const defaultProjection = toModelMessagesFromStoredMessages(messages);
    const explicitModelProjection = toModelMessagesFromStoredMessages(messages, { mode: "model" });

    expect(defaultProjection).toEqual(explicitModelProjection);
    expect(explicitModelProjection).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
      { role: "user", content: "how are you" },
    ]);
  });

  test("synthetic compaction message is preserved by projection (not skipped)", () => {
    const tailMsg = storedMessage("user", [textPart("tail")]);
    const compactionMsg = storedMessage("user", [
      compactionPart("Summary text", tailMsg.id),
    ]);

    const messages = [compactionMsg, tailMsg];

    const projected = toModelMessagesFromStoredMessages(messages);

    expect(projected[0]).toEqual({
      role: "user",
      content: "<compact-summary>\nSummary text\n</compact-summary>",
    });
    expect(projected[1]).toEqual({ role: "user", content: "tail" });
  });

  test("current incomplete user message is in tail (not in summary)", () => {
    const tailMsg = storedMessage("user", [textPart("current question")]);

    const compactionMsg = storedMessage("user", [
      compactionPart("Summary of earlier conversation", tailMsg.id),
    ]);

    const prefixMsg = storedMessage("user", [textPart("old question")], true);

    const messages = [prefixMsg, compactionMsg, tailMsg];

    const projected = toModelMessagesFromStoredMessages(messages);

    const userContents = projected
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : ""));

    expect(userContents.some((c) => c.includes("current question"))).toBe(true);
    expect(userContents.some((c) => c.includes("old question"))).toBe(false);
  });

  test("meta propagation: CompletedToolPart with meta projects normally", () => {
    const messages = [
      storedMessage("assistant", [
        completedToolPart({
          toolCallId: "call-meta",
          toolName: "bash",
          input: "ls",
          output: "file.txt",
          meta: { exitCode: 0 },
        }),
      ]),
    ];

    const projected = toModelMessagesFromStoredMessages(messages);
    expect(projected).toHaveLength(2);
    expect(projected[0]).toEqual({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-meta", toolName: "bash", input: "ls" }],
    });
    expect(projected[1]).toEqual({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-meta", toolName: "bash", output: { type: "text", value: "file.txt" } }],
    });
  });

  test("full-history mode projects compacted tool parts", () => {
    const prefixMsg = storedMessage("assistant", [
      completedToolPart({ toolCallId: "call-old", toolName: "read", input: { path: "old" }, output: "old content" }),
    ], true);

    const tailMsg = storedMessage("user", [textPart("new question")]);
    const compactionMsg = storedMessage("user", [
      compactionPart("Summary", tailMsg.id),
    ]);

    const messages = [prefixMsg, compactionMsg, tailMsg];

    const projected = toModelMessagesFromStoredMessages(messages, { mode: "full-history" });

    expect(projected).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-old", toolName: "read", input: { path: "old" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-old", toolName: "read", output: { type: "text", value: "old content" } }],
      },
      { role: "user", content: "new question" },
    ]);
  });
});