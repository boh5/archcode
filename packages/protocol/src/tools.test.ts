import { describe, expect, test } from "bun:test";
import {
  TOOL_FILE_READ,
  TOOL_FILE_WRITE,
  TOOL_FILE_EDIT,
  TOOL_GREP,
  TOOL_GLOB,
  TOOL_AST_GREP_SEARCH,
  TOOL_AST_GREP_REPLACE,
  TOOL_GIT_STATUS,
  TOOL_GIT_DIFF,
  TOOL_BASH,
  TOOL_TODO_WRITE,
  TOOL_ASK_USER,
  TOOL_LSP_DIAGNOSTICS,
  TOOL_LSP_GOTO_DEFINITION,
  TOOL_LSP_FIND_REFERENCES,
  TOOL_LSP_SYMBOLS,
  TOOL_WEB_FETCH,
  TOOL_DELEGATE,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_BACKGROUND_OUTPUT,
  TOOL_VIEW_TOOL_OUTPUT,
  TOOL_SKILL_LIST,
  TOOL_SKILL_READ,
  TOOL_MEMORY_READ,
  TOOL_MEMORY_WRITE,
  TOOL_WORKFLOW_CREATE,
  TOOL_WORKFLOW_READ,
  TOOL_WORKFLOW_UPDATE_STAGE,
  TOOL_WORKFLOW_TASK_CHECK,
  TOOL_ARTIFACT_READ,
  TOOL_ARTIFACT_WRITE,
  TOOL_CATEGORY_MAP,
  getToolCategory,
  isBuiltinToolName,
} from "./tools";

const ALL_BUILTIN_NAMES = [
  TOOL_FILE_READ,
  TOOL_FILE_WRITE,
  TOOL_FILE_EDIT,
  TOOL_GREP,
  TOOL_GLOB,
  TOOL_AST_GREP_SEARCH,
  TOOL_AST_GREP_REPLACE,
  TOOL_GIT_STATUS,
  TOOL_GIT_DIFF,
  TOOL_BASH,
  TOOL_TODO_WRITE,
  TOOL_ASK_USER,
  TOOL_LSP_DIAGNOSTICS,
  TOOL_LSP_GOTO_DEFINITION,
  TOOL_LSP_FIND_REFERENCES,
  TOOL_LSP_SYMBOLS,
  TOOL_WEB_FETCH,
  TOOL_DELEGATE,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_BACKGROUND_OUTPUT,
  TOOL_VIEW_TOOL_OUTPUT,
  TOOL_SKILL_LIST,
  TOOL_SKILL_READ,
  TOOL_MEMORY_READ,
  TOOL_MEMORY_WRITE,
  TOOL_WORKFLOW_CREATE,
  TOOL_WORKFLOW_READ,
  TOOL_WORKFLOW_UPDATE_STAGE,
  TOOL_WORKFLOW_TASK_CHECK,
  TOOL_ARTIFACT_READ,
  TOOL_ARTIFACT_WRITE,
] as const;

describe("tool name constants", () => {
  test("all builtin names have correct string values", () => {
    expect(TOOL_FILE_READ).toBe("file_read");
    expect(TOOL_FILE_WRITE).toBe("file_write");
    expect(TOOL_FILE_EDIT).toBe("file_edit");
    expect(TOOL_GREP).toBe("grep");
    expect(TOOL_GLOB).toBe("glob");
    expect(TOOL_AST_GREP_SEARCH).toBe("ast_grep_search");
    expect(TOOL_AST_GREP_REPLACE).toBe("ast_grep_replace");
    expect(TOOL_GIT_STATUS).toBe("git_status");
    expect(TOOL_GIT_DIFF).toBe("git_diff");
    expect(TOOL_BASH).toBe("bash");
    expect(TOOL_TODO_WRITE).toBe("todo_write");
    expect(TOOL_ASK_USER).toBe("ask_user");
    expect(TOOL_LSP_DIAGNOSTICS).toBe("lsp_diagnostics");
    expect(TOOL_LSP_GOTO_DEFINITION).toBe("lsp_goto_definition");
    expect(TOOL_LSP_FIND_REFERENCES).toBe("lsp_find_references");
    expect(TOOL_LSP_SYMBOLS).toBe("lsp_symbols");
    expect(TOOL_WEB_FETCH).toBe("web_fetch");
    expect(TOOL_DELEGATE).toBe("delegate");
    expect(TOOL_WAIT_FOR_REMINDER).toBe("wait_for_reminder");
    expect(TOOL_BACKGROUND_OUTPUT).toBe("background_output");
    expect(TOOL_VIEW_TOOL_OUTPUT).toBe("view_tool_output");
    expect(TOOL_SKILL_LIST).toBe("skill_list");
    expect(TOOL_SKILL_READ).toBe("skill_read");
    expect(TOOL_MEMORY_READ).toBe("memory_read");
    expect(TOOL_MEMORY_WRITE).toBe("memory_write");
    expect(TOOL_WORKFLOW_CREATE).toBe("workflow_create");
    expect(TOOL_WORKFLOW_READ).toBe("workflow_read");
    expect(TOOL_WORKFLOW_UPDATE_STAGE).toBe("workflow_update_stage");
    expect(TOOL_WORKFLOW_TASK_CHECK).toBe("workflow_task_check");
    expect(TOOL_ARTIFACT_READ).toBe("artifact_read");
    expect(TOOL_ARTIFACT_WRITE).toBe("artifact_write");
  });
});

describe("TOOL_CATEGORY_MAP", () => {
  test("all builtin names map to a non-other category", () => {
    for (const name of ALL_BUILTIN_NAMES) {
      const cat = TOOL_CATEGORY_MAP[name];
      expect(cat).toBeDefined();
      expect(cat).not.toBe("other");
    }
  });

  test("category values are correct per classification", () => {
    expect(TOOL_CATEGORY_MAP[TOOL_FILE_READ]).toBe("fileRead");
    expect(TOOL_CATEGORY_MAP[TOOL_FILE_WRITE]).toBe("fileWrite");
    expect(TOOL_CATEGORY_MAP[TOOL_FILE_EDIT]).toBe("fileWrite");
    expect(TOOL_CATEGORY_MAP[TOOL_GREP]).toBe("search");
    expect(TOOL_CATEGORY_MAP[TOOL_GLOB]).toBe("search");
    expect(TOOL_CATEGORY_MAP[TOOL_AST_GREP_SEARCH]).toBe("search");
    expect(TOOL_CATEGORY_MAP[TOOL_AST_GREP_REPLACE]).toBe("fileWrite");
    expect(TOOL_CATEGORY_MAP[TOOL_BASH]).toBe("shell");
    expect(TOOL_CATEGORY_MAP[TOOL_WEB_FETCH]).toBe("web");
    expect(TOOL_CATEGORY_MAP[TOOL_WORKFLOW_UPDATE_STAGE]).toBe("workflow");
    expect(TOOL_CATEGORY_MAP[TOOL_SKILL_LIST]).toBe("skill");
    expect(TOOL_CATEGORY_MAP[TOOL_MEMORY_READ]).toBe("memory");
    expect(TOOL_CATEGORY_MAP[TOOL_ARTIFACT_READ]).toBe("fileRead");
    expect(TOOL_CATEGORY_MAP[TOOL_ARTIFACT_WRITE]).toBe("fileWrite");
  });
});

describe("getToolCategory()", () => {
  test("MCP prefix returns mcp", () => {
    expect(getToolCategory("mcp__context7__resolve")).toBe("mcp");
    expect(getToolCategory("mcp__server__tool")).toBe("mcp");
  });

  test("undefined returns other", () => {
    expect(getToolCategory(undefined)).toBe("other");
  });

  test("empty string returns other", () => {
    expect(getToolCategory("")).toBe("other");
  });

  test("unknown string returns other", () => {
    expect(getToolCategory("nonexistent_tool")).toBe("other");
  });

  test("known builtin returns correct category", () => {
    expect(getToolCategory("file_read")).toBe("fileRead");
    expect(getToolCategory("grep")).toBe("search");
    expect(getToolCategory("bash")).toBe("shell");
    expect(getToolCategory("workflow_create")).toBe("workflow");
    expect(getToolCategory("workflow_update_stage")).toBe("workflow");
  });
});

describe("isBuiltinToolName()", () => {
  test("returns true for known builtin names", () => {
    expect(isBuiltinToolName("file_read")).toBe(true);
    expect(isBuiltinToolName("grep")).toBe(true);
    expect(isBuiltinToolName("workflow_update_stage")).toBe(true);
    expect(isBuiltinToolName("ast_grep_replace")).toBe(true);
  });

  test("returns false for unknown names", () => {
    expect(isBuiltinToolName("mcp__foo")).toBe(false);
    expect(isBuiltinToolName("unknown_tool")).toBe(false);
    expect(isBuiltinToolName("")).toBe(false);
  });

  test("acts as a type guard narrowing to BuiltinToolName", () => {
    const name: string = "file_read";
    if (isBuiltinToolName(name)) {
      const cat: "fileRead" | "fileWrite" | "search" | "git" | "shell" | "interaction" | "lsp" | "web" | "delegation" | "skill" | "memory" | "workflow" | "mcp" | "other" = TOOL_CATEGORY_MAP[name];
      expect(cat).toBe("fileRead");
    }
  });
});
