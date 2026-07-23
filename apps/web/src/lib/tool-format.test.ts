import { describe, expect, test } from "bun:test";
import {
  getToolIcon,
  getToolSummary,
  getToolDiffMetadata,
  summarizeToolDiffMetadata,
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
  test("uses tool category only for the icon and summarizes input generically", () => {
    const input = { first_value: "Install deps", second_value: "bun install" };
    const result = getToolSummary("bash", input);
    const custom = getToolSummary("custom_tool", input);

    expect(result.icon).toBe(Terminal);
    expect(result.primary).toBe("Install deps");
    expect(result.secondary).toBe("bun install");
    expect(custom.icon).toBe(CircleQuestionMark);
    expect(custom.primary).toBe(result.primary);
    expect(custom.secondary).toBe(result.secondary);
  });

  test("does not depend on builtin or MCP parameter names", () => {
    const builtin = getToolSummary("memory_read", {
      arbitrary_exact_key: "preferences",
      another_exact_key: false,
    });
    const mcp = getToolSummary("mcp__docs__lookup", {
      arbitrary_exact_key: "preferences",
      another_exact_key: false,
    });

    expect(builtin.primary).toBe("preferences");
    expect(builtin.secondary).toBe("false");
    expect(mcp.primary).toBe(builtin.primary);
    expect(mcp.secondary).toBe(builtin.secondary);
    expect(mcp.icon).toBe(Plug);
  });

  test("finds bounded nested values without knowing their keys", () => {
    const result = getToolSummary("ask_user", {
      any_container: [{ first_nested_key: "Scope", second_nested_key: "Proceed?" }],
    });
    expect(result.primary).toBe("Scope");
    expect(result.secondary).toBe("Proceed?");
  });

  test("summarizes long strings by size rather than rendering their contents", () => {
    const content = Array.from({ length: 9 }, (_, index) => `line-${index}`).join("\n");
    const result = getToolSummary("file_write", { any_path_key: "/src/index.ts", any_content_key: content });
    expect(result.primary).toBe("/src/index.ts");
    expect(result.secondary).toBe(`${content.length} chars, 9 lines`);
  });

  test("handles absent, empty, array, and primitive input deterministically", () => {
    expect(getToolSummary("file_read", null).primary).toBe("—");
    expect(getToolSummary("file_read", undefined).primary).toBe("—");
    expect(getToolSummary("file_read", {}).primary).toBe("{0 fields}");
    expect(getToolSummary("file_read", []).primary).toBe("[0 items]");
    expect(getToolSummary("file_read", [1, 2, 3])).toMatchObject({ primary: "1", secondary: "2" });
    expect(getToolSummary("file_read", "just a string").primary).toBe("just a string");
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
