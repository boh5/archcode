import { describe, expect, test } from "bun:test";
import {
  TOOL_ASK_USER,
  TOOL_DELEGATE,
  type SessionMessage,
  type SessionPart,
  type ToolPart,
} from "@archcode/protocol";
import { buildToolRunTimeline } from "./tool-runs";

let nextTimestamp = 0;

function partTime(): number {
  nextTimestamp += 1;
  return nextTimestamp;
}

function tool(id: string, toolName = "file_read", state: ToolPart["state"] = "running"): ToolPart {
  const createdAt = partTime();
  if (state === "pending") {
    return { type: "tool", id, state, toolCallId: `call-${id}`, toolName, createdAt };
  }
  const base = {
    type: "tool" as const,
    id,
    toolCallId: `call-${id}`,
    toolName,
    input: { path: `${id}.ts` },
    createdAt,
    startedAt: createdAt,
  };
  if (state === "running") return { ...base, state };
  return {
    ...base,
    state,
    endedAt: createdAt,
    result: {
      isError: state === "error",
      output: {
        preview: "",
        completeness: "complete",
        observed: { bytes: 0, lines: 0 },
        canonical: { bytes: 0, lines: 0 },
        stored: { bytes: 0, lines: 0 },
        omitted: { bytes: 0, lines: 0 },
        recovery: { kind: "none" },
      },
    },
  };
}

function text(id: string, value: string): SessionPart {
  const createdAt = partTime();
  return { type: "text", id, text: value, createdAt, completedAt: createdAt };
}

function reasoning(id: string): SessionPart {
  const createdAt = partTime();
  return { type: "reasoning", id, text: id, createdAt, completedAt: createdAt };
}

function notice(id: string): SessionPart {
  const createdAt = partTime();
  return { type: "system-notice", id, notice: id, createdAt, completedAt: createdAt };
}

function message(id: string, parts: SessionPart[], role: SessionMessage["role"] = "assistant"): SessionMessage {
  return { id, role, parts, createdAt: partTime(), completedAt: partTime() };
}

function slices(...messages: SessionMessage[]) {
  return messages.map((entry) => ({ message: entry, parts: entry.parts }));
}

describe("buildToolRunTimeline", () => {
  test("keeps Reasoning outside Tool Runs and groups only contiguous tools", () => {
    const result = buildToolRunTimeline(slices(
      message("intro", [text("text-a", "I will inspect this.")]),
      message("tools-a", [reasoning("reason-a"), tool("one"), tool("two")]),
      message("tools-b", [tool("three"), reasoning("reason-b"), tool("four"), tool("five")]),
      message("middle", [text("text-b", "The first pass found the boundary.")]),
      message("tools-c", [tool("six"), tool("seven"), tool("eight")]),
    ));

    expect(result.map((entry) => entry.kind)).toEqual([
      "message",
      "message",
      "tool-run",
      "message",
      "tool-run",
      "message",
      "tool-run",
    ]);
    expect(result[2]?.kind === "tool-run" ? result[2].tools.map((entry) => entry.id) : []).toEqual([
      "one", "two", "three",
    ]);
    expect(result[4]?.kind === "tool-run" ? result[4].tools.map((entry) => entry.id) : []).toEqual([
      "four", "five",
    ]);
    expect(result[6]?.kind === "tool-run" ? result[6].tools.map((entry) => entry.id) : []).toEqual([
      "six", "seven", "eight",
    ]);
    expect(result.filter((entry) => entry.kind === "message").flatMap((entry) =>
      entry.kind === "message" ? entry.parts.filter((part) => part.type === "reasoning").map((part) => part.id) : []
    )).toEqual(["reason-a", "reason-b"]);
  });

  test("treats Reasoning as a hard boundary across model messages", () => {
    const result = buildToolRunTimeline(slices(
      message("first", [tool("one"), reasoning("between")]),
      message("second", [reasoning("next-step"), tool("two")]),
    ));

    expect(result).toHaveLength(2);
    expect(result.every((entry) => entry.kind === "message")).toBe(true);
    expect(result.flatMap((entry) =>
      entry.kind === "message" ? entry.parts.map((part) => part.id) : []
    )).toEqual(["one", "between", "next-step", "two"]);
  });

  test("renders trailing Reasoning after a completed Tool Run in the outer timeline", () => {
    const result = buildToolRunTimeline(slices(
      message("source", [tool("one", "file_read", "completed"), tool("two", "grep", "completed"), reasoning("after-tools")]),
    ));

    expect(result.map((entry) => entry.kind)).toEqual(["tool-run", "message"]);
    expect(result[0]?.kind === "tool-run" ? result[0].tools.map((part) => part.id) : []).toEqual(["one", "two"]);
    expect(result[1]?.kind === "message" ? result[1].parts.map((part) => part.id) : []).toEqual(["after-tools"]);
  });

  test("keeps a singleton tool direct and preserves its message metadata", () => {
    const source = message("singleton", [reasoning("why"), tool("one"), reasoning("after")]);
    const result = buildToolRunTimeline(slices(source));

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("message");
    if (result[0]?.kind === "message") {
      expect(result[0].parts.map((part) => part.id)).toEqual(["why", "one", "after"]);
      expect(result[0].showMeta).toBe(true);
    }
  });

  test("uses delegate, ask_user, notices, and user messages as hard boundaries", () => {
    const result = buildToolRunTimeline(slices(
      message("assistant", [
        tool("one"),
        tool("two"),
        tool("delegate", TOOL_DELEGATE),
        tool("three"),
        tool("ask", TOOL_ASK_USER),
        tool("four"),
        notice("notice"),
        tool("five"),
        tool("six"),
      ]),
      message("user", [text("reply", "Yes")], "user"),
      message("after-user", [tool("seven"), tool("eight")]),
    ));

    expect(result.filter((entry) => entry.kind === "tool-run").map((entry) =>
      entry.kind === "tool-run" ? entry.tools.map((part) => part.id) : []
    )).toEqual([
      ["one", "two"],
      ["five", "six"],
      ["seven", "eight"],
    ]);
    expect(result.filter((entry) => entry.kind === "message").flatMap((entry) =>
      entry.kind === "message" ? entry.parts.map((part) => part.id) : []
    )).toEqual(["delegate", "three", "ask", "four", "notice", "reply"]);
  });

  test("derives a stable run id only from its first tool while more calls append", () => {
    const first = message("first", [tool("one"), tool("two")]);
    const initial = buildToolRunTimeline(slices(first));
    const appended = buildToolRunTimeline(slices(first, message("second", [tool("three")])));

    expect(initial[0]?.id).toBe("tool-run:one");
    expect(appended[0]?.id).toBe(initial[0]?.id);
  });

  test("shows message metadata once after a message is split around a run", () => {
    const source = message("mixed", [
      text("before", "Before"),
      tool("one"),
      tool("two"),
      text("after", "After"),
    ]);
    const result = buildToolRunTimeline(slices(source));
    const messageEntries = result.filter(
      (entry): entry is Extract<(typeof result)[number], { kind: "message" }> => entry.kind === "message",
    );

    expect(messageEntries).toHaveLength(2);
    expect(messageEntries.map((entry) => entry.showMeta)).toEqual([false, true]);
  });

  test("does not insert message metadata between text and a trailing Tool Run", () => {
    const source = message("mixed", [
      text("before", "Before"),
      tool("one"),
      tool("two"),
    ]);
    const result = buildToolRunTimeline(slices(source));

    expect(result.map((entry) => entry.kind)).toEqual(["message", "tool-run"]);
    expect(result[0]?.kind === "message" ? result[0].showMeta : undefined).toBe(false);
  });
});
