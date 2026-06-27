import { describe, expect, test } from "bun:test";
import { groupReadOnlyToolParts, READ_ONLY_TOOL_NAMES } from "./group-tools";
import type { SessionPart, ToolPart } from "@archcode/protocol";

function makeTool(toolName: string, state: ToolPart["state"] = "completed"): ToolPart {
  return {
    type: "tool",
    id: `${toolName}-${state}-${Math.random().toString(36).slice(2, 8)}`,
    toolCallId: "tc_" + Math.random().toString(36).slice(2, 8),
    toolName,
    state,
    createdAt: Date.now(),
    input: {},
  } as unknown as ToolPart;
}

function makeText(text: string): SessionPart {
  return {
    type: "text",
    id: "text-" + Math.random().toString(36).slice(2, 8),
    text,
    completedAt: Date.now(),
    createdAt: Date.now(),
  } as unknown as SessionPart;
}

function toolNames(entries: ReturnType<typeof groupReadOnlyToolParts>): string[] {
  return entries.flatMap((e) =>
    e.type === "grouped-tools" ? e.tools.map((t) => t.toolName) : e.type === "tool" ? [(e as ToolPart).toolName] : [],
  );
}

describe("groupReadOnlyToolParts", () => {
  test("groups 3 consecutive completed file_read into one group", () => {
    const parts: SessionPart[] = [
      makeTool("file_read"),
      makeTool("file_read"),
      makeTool("file_read"),
    ];
    const result = groupReadOnlyToolParts(parts);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("grouped-tools");
    if (result[0].type === "grouped-tools") {
      expect(result[0].tools).toHaveLength(3);
    }
  });

  test("file_read then bash renders as 2 standalone", () => {
    const parts: SessionPart[] = [makeTool("file_read"), makeTool("bash")];
    const result = groupReadOnlyToolParts(parts);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("tool");
    expect(result[1].type).toBe("tool");
  });

  test("running file_read at tail breaks group — 2 standalone", () => {
    const parts: SessionPart[] = [
      makeTool("file_read"),
      makeTool("file_read", "running"),
    ];
    const result = groupReadOnlyToolParts(parts);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("tool");
    expect(result[1].type).toBe("tool");
  });

  test("mixed completed reads (file_read, grep, glob) group into one", () => {
    const parts: SessionPart[] = [
      makeTool("file_read"),
      makeTool("grep"),
      makeTool("glob"),
    ];
    const result = groupReadOnlyToolParts(parts);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("grouped-tools");
    if (result[0].type === "grouped-tools") {
      expect(result[0].tools).toHaveLength(3);
    }
  });

  test("file_read, delegate, file_read — 3 standalone (non-contiguous, delegate excluded)", () => {
    const parts: SessionPart[] = [
      makeTool("file_read"),
      makeTool("delegate"),
      makeTool("file_read"),
    ];
    const result = groupReadOnlyToolParts(parts);
    expect(result).toHaveLength(3);
    expect(toolNames(result)).toEqual(["file_read", "delegate", "file_read"]);
  });

  test("single completed read stays standalone (threshold >=2)", () => {
    const parts: SessionPart[] = [makeTool("file_read")];
    const result = groupReadOnlyToolParts(parts);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("tool");
  });

  test("non-tool parts (text) break groups", () => {
    const parts: SessionPart[] = [
      makeTool("file_read"),
      makeTool("file_read"),
      makeText("hello"),
      makeTool("file_read"),
      makeTool("file_read"),
    ];
    const result = groupReadOnlyToolParts(parts);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("grouped-tools");
    expect(result[1].type).toBe("text");
    expect(result[2].type).toBe("grouped-tools");
  });

  test("group id is stable (derived from first and last tool ids)", () => {
    const parts: SessionPart[] = [
      makeTool("file_read"),
      makeTool("file_read"),
    ];
    const result = groupReadOnlyToolParts(parts);
    if (result[0].type === "grouped-tools") {
      const expectedId = `${parts[0].id}:${parts[1].id}`;
      expect(result[0].id).toBe(expectedId);
    }
  });

  test("empty array returns empty", () => {
    expect(groupReadOnlyToolParts([])).toEqual([]);
  });

  test("error-state read-only tool does NOT group", () => {
    const parts: SessionPart[] = [
      makeTool("file_read"),
      makeTool("file_read", "error"),
      makeTool("file_read"),
    ];
    const result = groupReadOnlyToolParts(parts);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("tool");
    expect(result[1].type).toBe("tool");
    expect(result[2].type).toBe("tool");
  });

  test("ast_grep_search is read-only and groups", () => {
    const parts: SessionPart[] = [
      makeTool("ast_grep_search"),
      makeTool("ast_grep_search"),
    ];
    const result = groupReadOnlyToolParts(parts);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("grouped-tools");
  });

  test("ast_grep_replace is NOT read-only (destructive) — stays standalone", () => {
    const parts: SessionPart[] = [
      makeTool("ast_grep_replace"),
      makeTool("ast_grep_replace"),
    ];
    const result = groupReadOnlyToolParts(parts);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("tool");
    expect(result[1].type).toBe("tool");
  });

  test("READ_ONLY_TOOL_NAMES includes lsp, git, web, memory_read, artifact_read", () => {
    expect(READ_ONLY_TOOL_NAMES.has("lsp_diagnostics")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("lsp_goto_definition")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("git_status")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("git_diff")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("web_fetch")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("memory_read")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("artifact_read")).toBe(true);
  });

  test("READ_ONLY_TOOL_NAMES excludes file_write, file_edit, bash, delegate, todo_write, ast_grep_replace, ask_user", () => {
    expect(READ_ONLY_TOOL_NAMES.has("file_write")).toBe(false);
    expect(READ_ONLY_TOOL_NAMES.has("file_edit")).toBe(false);
    expect(READ_ONLY_TOOL_NAMES.has("bash")).toBe(false);
    expect(READ_ONLY_TOOL_NAMES.has("delegate")).toBe(false);
    expect(READ_ONLY_TOOL_NAMES.has("todo_write")).toBe(false);
    expect(READ_ONLY_TOOL_NAMES.has("ast_grep_replace")).toBe(false);
    expect(READ_ONLY_TOOL_NAMES.has("ask_user")).toBe(false);
  });
});
