import { describe, expect, test } from "bun:test";
import {
  getToolIcon,
  getToolSummary,
  formatToolInputDetails,
  getToolDiffMetadata,
  summarizeToolDiffMetadata,
  getToolInvalidInputMessage,
  INLINE_VALUE_MAX_CHARS,
  INLINE_VALUE_MAX_LINES,
  CONTENT_SUMMARY_THRESHOLD_CHARS,
  CONTENT_SUMMARY_THRESHOLD_LINES,
} from "./tool-format";
import type { ToolDiffMetadata } from "@archcode/protocol";
import {
  FileText,
  Pencil,
  Search,
  GitBranch,
  Terminal,
  MessageSquare,
  Wrench,
  Globe,
  Handshake,
  Zap,
  Brain,
  Plug,
  Target,
  CircleQuestionMark,
} from "lucide-react";

describe("getToolIcon", () => {
  test("returns correct icon for each category", () => {
    expect(getToolIcon("fileRead")).toBe(FileText);
    expect(getToolIcon("fileWrite")).toBe(Pencil);
    expect(getToolIcon("search")).toBe(Search);
    expect(getToolIcon("git")).toBe(GitBranch);
    expect(getToolIcon("shell")).toBe(Terminal);
    expect(getToolIcon("interaction")).toBe(MessageSquare);
    expect(getToolIcon("lsp")).toBe(Wrench);
    expect(getToolIcon("web")).toBe(Globe);
    expect(getToolIcon("delegation")).toBe(Handshake);
    expect(getToolIcon("skill")).toBe(Zap);
    expect(getToolIcon("memory")).toBe(Brain);
    expect(getToolIcon("goal")).toBe(Target);
    expect(getToolIcon("mcp")).toBe(Plug);
    expect(getToolIcon("other")).toBe(CircleQuestionMark);
  });
});

describe("getToolSummary", () => {
  test("bash returns two-part model with description and command", () => {
    const result = getToolSummary("bash", { description: "Install deps", command: "bun install" });
    expect(result.icon).toBe(Terminal);
    expect(result.primary).toBe("Install deps");
    expect(result.secondary).toBe("bun install");
  });

  test("bash with only command falls back to command as primary", () => {
    const result = getToolSummary("bash", { command: "pwd" });
    expect(result.primary).toBe("pwd");
    expect(result.secondary).toBeUndefined();
  });

  test("bash with null input returns dash", () => {
    const result = getToolSummary("bash", null);
    expect(result.primary).toBe("—");
  });

  test("file_read returns path", () => {
    const result = getToolSummary("file_read", { filePath: "/src/index.ts" });
    expect(result.icon).toBe(FileText);
    expect(result.primary).toBe("/src/index.ts");
  });

  test("file_write returns path and content stats", () => {
    const content = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9";
    const result = getToolSummary("file_write", { filePath: "/src/index.ts", content });
    expect(result.primary).toBe("/src/index.ts");
    expect(result.secondary).toContain("chars");
    expect(result.secondary).toContain("lines");
  });

  test("grep returns pattern", () => {
    const result = getToolSummary("grep", { pattern: "TODO", include: "*.ts" });
    expect(result.icon).toBe(Search);
    expect(result.primary).toBe("TODO");
  });

  test("delegate shows agent_type: title summary with task secondary", () => {
    const result = getToolSummary("delegate", { agent_type: "explore", title: "Explore codebase", task: "Inspect the source" });
    expect(result.icon).toBe(Handshake);
    expect(result.primary).toBe("explore: Explore codebase");
    expect(result.secondary).toBe("Inspect the source");
  });

  test("background_output shows session_id", () => {
    const result = getToolSummary("background_output", { session_id: "ses_abc123" });
    expect(result.icon).toBe(Handshake);
    expect(result.primary).toBe("ses_abc123");
  });

  test("resume_session shows session_id with task secondary", () => {
    const result = getToolSummary("resume_session", { session_id: "ses_abc123", task: "Continue the investigation" });
    expect(result.primary).toBe("ses_abc123");
    expect(result.secondary).toBe("Continue the investigation");
  });

  test("MCP tool renders as server/tool with primary value", () => {
    const result = getToolSummary("mcp__context7__resolve_library", { query: "react hooks" });
    expect(result.icon).toBe(Plug);
    expect(result.primary).toBe("react hooks");
  });

  test("MCP tool with url field uses url as primary", () => {
    const result = getToolSummary("mcp__exa__search", { url: "https://example.com", numResults: 5 });
    expect(result.primary).toBe("https://example.com");
  });

  test("MCP tool with no meaningful string falls back to server/tool", () => {
    const result = getToolSummary("mcp__myserver__mytool", { count: 42 });
    expect(result.primary).toBe("myserver/mytool");
  });

  test("web_fetch returns url", () => {
    const result = getToolSummary("web_fetch", { url: "https://docs.example.com" });
    expect(result.icon).toBe(Globe);
    expect(result.primary).toBe("https://docs.example.com");
  });

  test("LSP tools return path", () => {
    const result = getToolSummary("lsp_diagnostics", { filePath: "/src/app.ts" });
    expect(result.icon).toBe(Wrench);
    expect(result.primary).toBe("/src/app.ts");
  });

  test("git_status returns workdir", () => {
    const result = getToolSummary("git_status", { workdir: "/project" });
    expect(result.icon).toBe(GitBranch);
    expect(result.primary).toBe("/project");
  });

  test("unknown tool returns safe fallback", () => {
    const result = getToolSummary("custom_tool", { foo: "bar" });
    expect(result.icon).toBe(CircleQuestionMark);
    expect(result.primary).toBe("bar");
  });

  test("null input returns dash", () => {
    const result = getToolSummary("file_read", null);
    expect(result.primary).toBe("—");
  });

  test("undefined input returns dash", () => {
    const result = getToolSummary("file_read", undefined);
    expect(result.primary).toBe("—");
  });

  test("array input returns string representation", () => {
    const result = getToolSummary("file_read", [1, 2, 3]);
    expect(result.primary).toBe("1,2,3");
  });

  test("string input returns truncated string", () => {
    const result = getToolSummary("file_read", "just a string");
    expect(result.primary).toBe("just a string");
  });

  test("artifact_write is treated as an unknown legacy tool", () => {
    const content = "a".repeat(300);
    const result = getToolSummary("artifact_write", { legacyId: "wf-1", kind: "PRD", content });
    expect(result.primary).toBe("wf-1");
    expect(result.secondary).toBeUndefined();
  });

  test("truncates long primary values", () => {
    const longText = "a".repeat(200);
    const result = getToolSummary("ask_user", { question: longText });
    expect(result.primary.length).toBeLessThanOrEqual(INLINE_VALUE_MAX_CHARS + 1);
  });

  test("ask_user uses the first structured question as its summary", () => {
    const result = getToolSummary("ask_user", {
      questions: [{ header: "Goal", question: "What do you want to build?", options: [], custom: true }],
    });

    expect(result.primary).toBe("What do you want to build?");
  });
});

describe("formatToolInputDetails", () => {
  test("bash shows description and command", () => {
    const result = formatToolInputDetails("bash", { description: "Install deps", command: "bun install" });
    expect(result).not.toBeNull();
    expect(result!.description).toBe("Install deps");
    expect(result!.command).toBe("bun install");
  });

  test("file_write shows content stats only", () => {
    const content = "a".repeat(300);
    const result = formatToolInputDetails("file_write", { filePath: "/src/index.ts", content });
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe("/src/index.ts");
    expect(result!.content).toContain("chars");
    expect(result!.content).toContain("lines");
    expect(result!.content).not.toContain("aaa");
  });

  test("artifact_write details use unknown-tool fallback", () => {
    const content = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";
    const result = formatToolInputDetails("artifact_write", { legacyId: "wf-1", kind: "PRD", content });
    expect(result).not.toBeNull();
    expect(result!.legacyId).toBe("wf-1");
    expect(result!.kind).toBe("PRD");
    expect(result!.content).toContain("chars");
    expect(result!.content).toContain("lines");
    expect(result!.content).not.toContain("line1");
  });

  test("file_edit shows edits count and per-edit stats", () => {
    const result = formatToolInputDetails("file_edit", {
      filePath: "/src/app.ts",
      edits: [
        { oldString: "const x = 1;\nconst y = 2;\nconst z = 3;\nconst w = 4;\nconst v = 5;", newString: "const x = 10;" },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe("/src/app.ts");
    expect(result!.edits).toBe("[1 edit]");
    expect(result!["edits[0].oldString"]).toContain("chars");
    expect(result!["edits[0].newString"]).toContain("chars");
  });

  test("MCP tool shows server/tool and primary value", () => {
    const result = formatToolInputDetails("mcp__context7__resolve_library", { query: "react" });
    expect(result).not.toBeNull();
    expect(result!.tool).toBe("context7/resolve_library");
    expect(result!.input).toBe("react");
  });

  test("grep shows pattern and include", () => {
    const result = formatToolInputDetails("grep", { pattern: "TODO", include: "*.ts", path: "/src" });
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("TODO");
    expect(result!.include).toBe("*.ts");
  });

  test("returns null for null input", () => {
    expect(formatToolInputDetails("bash", null)).toBeNull();
  });

  test("returns null for undefined input", () => {
    expect(formatToolInputDetails("bash", undefined)).toBeNull();
  });

  test("returns null for array input", () => {
    expect(formatToolInputDetails("bash", [1, 2, 3])).toBeNull();
  });

  test("returns null for string input", () => {
    expect(formatToolInputDetails("bash", "just a string")).toBeNull();
  });

  test("unknown tool shows first few fields", () => {
    const result = formatToolInputDetails("unknown_tool", { a: 1, b: "hello", c: true, d: "extra" });
    expect(result).not.toBeNull();
    expect(result!.a).toBe("1");
    expect(result!.b).toBe("hello");
    expect(result!.c).toBe("true");
    expect(result!.d).toBeUndefined();
  });

  test("truncates long string values", () => {
    const longVal = "x".repeat(200);
    const result = formatToolInputDetails("bash", { description: longVal, command: "pwd" });
    expect(result!.description.length).toBeLessThanOrEqual(INLINE_VALUE_MAX_CHARS + 1);
  });

  test("summarizes content-like fields in unknown tools", () => {
    const content = "a".repeat(300);
    const result = formatToolInputDetails("unknown_tool", { content, name: "test" });
    expect(result).not.toBeNull();
    expect(result!.content).toContain("chars");
    expect(result!.content).toContain("lines");
  });
});

describe("getToolDiffMetadata", () => {
  test("returns undefined for null", () => {
    expect(getToolDiffMetadata(null)).toBeUndefined();
  });

  test("returns undefined for undefined", () => {
    expect(getToolDiffMetadata(undefined)).toBeUndefined();
  });

  test("returns undefined for non-object", () => {
    expect(getToolDiffMetadata("string")).toBeUndefined();
    expect(getToolDiffMetadata(42)).toBeUndefined();
  });

  test("returns undefined for array", () => {
    expect(getToolDiffMetadata([])).toBeUndefined();
  });

  test("rejects old versions while accepting the current unversioned shape", () => {
    expect(getToolDiffMetadata({ version: 1, files: [] })).toBeUndefined();
    expect(getToolDiffMetadata({ files: [] })).toEqual({ files: [] });
  });

  test("returns undefined for object without files array", () => {
    expect(getToolDiffMetadata({ warning: "missing" })).toBeUndefined();
    expect(getToolDiffMetadata({ files: "not array" })).toBeUndefined();
  });

  test("returns metadata for valid ToolDiffMetadata", () => {
    const meta: ToolDiffMetadata = {
      files: [{ path: "/src/app.ts", hunks: [] }],
    };
    const result = getToolDiffMetadata(meta);
    expect(result).not.toBeUndefined();
    expect(result!.files).toHaveLength(1);
  });

  test("returns metadata with optional fields", () => {
    const meta: ToolDiffMetadata = {
      files: [],
      truncated: true,
      warning: "Large diff",
    };
    const result = getToolDiffMetadata(meta);
    expect(result!.truncated).toBe(true);
    expect(result!.warning).toBe("Large diff");
  });

  test("rejects unknown top-level and recursive keys", () => {
    expect(getToolDiffMetadata({ files: [], extra: true })).toBeUndefined();
    expect(getToolDiffMetadata({ files: [{ path: "a.ts", hunks: [], extra: true }] })).toBeUndefined();
    expect(getToolDiffMetadata({
      files: [{
        path: "a.ts",
        hunks: [{
          header: "@@ -1 +1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [{ type: "add", content: "x", extra: true }],
        }],
      }],
    })).toBeUndefined();
  });

  test("rejects missing and invalid nested fields", () => {
    expect(getToolDiffMetadata({ files: [{ path: "a.ts" }] })).toBeUndefined();
    expect(getToolDiffMetadata({ files: [{ path: "a.ts", hunks: [{ header: "@@", lines: [] }] }] })).toBeUndefined();
    expect(getToolDiffMetadata({
      files: [{
        path: "a.ts",
        hunks: [{
          header: "@@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [{ type: "future", content: "x" }],
        }],
      }],
    })).toBeUndefined();
  });
});

describe("summarizeToolDiffMetadata", () => {
  test("sums additions and deletions only when every file has both finite counts", () => {
    expect(summarizeToolDiffMetadata({
      files: [
        { path: "a.ts", additions: 2, deletions: 1, hunks: [] },
        { path: "b.ts", additions: 4, deletions: 3, hunks: [] },
      ],
    })).toEqual({ fileCount: 2, additions: 6, deletions: 4 });

    expect(summarizeToolDiffMetadata({
      files: [
        { path: "a.ts", additions: 2, deletions: 1, hunks: [] },
        { path: "b.ts", additions: 4, hunks: [] },
      ],
    })).toEqual({ fileCount: 2 });
  });

  test("empty valid metadata reports only its file count", () => {
    expect(summarizeToolDiffMetadata({ files: [] })).toEqual({ fileCount: 0 });
  });
});

describe("getToolInvalidInputMessage", () => {
  test("bash missing description returns message", () => {
    const result = getToolInvalidInputMessage("bash", { command: "pwd" });
    expect(result).toBe("Invalid bash input: missing required description");
  });

  test("bash with empty description returns message", () => {
    const result = getToolInvalidInputMessage("bash", { command: "pwd", description: "  " });
    expect(result).toBe("Invalid bash input: missing required description");
  });

  test("bash with valid input returns null", () => {
    const result = getToolInvalidInputMessage("bash", { command: "pwd", description: "Check directory" });
    expect(result).toBeNull();
  });

  test("bash missing command returns message", () => {
    const result = getToolInvalidInputMessage("bash", { description: "Do something" });
    expect(result).toBe("Invalid bash input: missing required command");
  });

  test("file_write missing path returns message", () => {
    const result = getToolInvalidInputMessage("file_write", { content: "hello" });
    expect(result).toBe("Invalid file_write input: missing required file path");
  });

  test("file_read missing path returns message", () => {
    const result = getToolInvalidInputMessage("file_read", {});
    expect(result).toBe("Invalid file_read input: missing required file path");
  });

  test("delegate missing agent_type returns message", () => {
    const result = getToolInvalidInputMessage("delegate", { title: "Explore", task: "Explore" });
    expect(result).toBe("Invalid delegate input: missing required agent_type");
  });

  test("delegate missing title returns message", () => {
    const result = getToolInvalidInputMessage("delegate", { agent_type: "explore", task: "Explore" });
    expect(result).toBe("Invalid delegate input: missing required title");
  });

  test("delegate missing task returns message", () => {
    const result = getToolInvalidInputMessage("delegate", { agent_type: "explore", title: "Explore" });
    expect(result).toBe("Invalid delegate input: missing required task");
  });

  test("resume_session validates session_id and task", () => {
    expect(getToolInvalidInputMessage("resume_session", { task: "Continue" })).toBe("Invalid resume_session input: missing required session_id");
    expect(getToolInvalidInputMessage("resume_session", { session_id: "ses_abc123" })).toBe("Invalid resume_session input: missing required task");
  });

  test("null input returns message", () => {
    const result = getToolInvalidInputMessage("bash", null);
    expect(result).toBe("Invalid bash input: missing input");
  });

  test("undefined input returns message", () => {
    const result = getToolInvalidInputMessage("bash", undefined);
    expect(result).toBe("Invalid bash input: missing input");
  });

  test("array input returns message", () => {
    const result = getToolInvalidInputMessage("bash", [1, 2]);
    expect(result).toBe("Invalid bash input: expected object, got array");
  });

  test("string input returns message", () => {
    const result = getToolInvalidInputMessage("bash", "just a string");
    expect(result).toBe("Invalid bash input: expected object, got string");
  });

  test("unknown tool with valid object returns null", () => {
    const result = getToolInvalidInputMessage("custom_tool", { foo: "bar" });
    expect(result).toBeNull();
  });

  test("file_write with filePath is valid", () => {
    const result = getToolInvalidInputMessage("file_write", { filePath: "/src/app.ts", content: "hello" });
    expect(result).toBeNull();
  });

  test("file_write with file_path (underscore) is valid", () => {
    const result = getToolInvalidInputMessage("file_write", { file_path: "/src/app.ts", content: "hello" });
    expect(result).toBeNull();
  });
});

describe("threshold constants", () => {
  test("INLINE_VALUE_MAX_CHARS is 160", () => {
    expect(INLINE_VALUE_MAX_CHARS).toBe(160);
  });

  test("INLINE_VALUE_MAX_LINES is 4", () => {
    expect(INLINE_VALUE_MAX_LINES).toBe(4);
  });

  test("CONTENT_SUMMARY_THRESHOLD_CHARS is 200", () => {
    expect(CONTENT_SUMMARY_THRESHOLD_CHARS).toBe(200);
  });

  test("CONTENT_SUMMARY_THRESHOLD_LINES is 8", () => {
    expect(CONTENT_SUMMARY_THRESHOLD_LINES).toBe(8);
  });
});
