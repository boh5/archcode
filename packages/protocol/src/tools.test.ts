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
  TOOL_WORKTREE_ENTER,
  TOOL_WORKTREE_EXIT,
  TOOL_GITHUB_GET_PULL_REQUEST,
  TOOL_GITHUB_LIST_PULL_REQUESTS,
  TOOL_GITHUB_GET_PULL_REQUEST_CHECKS,
  TOOL_GITHUB_LIST_ISSUE_COMMENTS,
  TOOL_GITHUB_CREATE_ISSUE_COMMENT,
  TOOL_GITHUB_LIST_WORKFLOW_RUNS,
  TOOL_GITHUB_GET_WORKFLOW_RUN,
  TOOL_GITHUB_RERUN_WORKFLOW_RUN,
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
  TOOL_GOAL_MANAGE,
  TOOL_GOAL_CREATE,
  TOOL_AUTOMATION_CREATE,
  TOOL_COMPRESS,
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
  TOOL_WORKTREE_ENTER,
  TOOL_WORKTREE_EXIT,
  TOOL_GITHUB_GET_PULL_REQUEST,
  TOOL_GITHUB_LIST_PULL_REQUESTS,
  TOOL_GITHUB_GET_PULL_REQUEST_CHECKS,
  TOOL_GITHUB_LIST_ISSUE_COMMENTS,
  TOOL_GITHUB_CREATE_ISSUE_COMMENT,
  TOOL_GITHUB_LIST_WORKFLOW_RUNS,
  TOOL_GITHUB_GET_WORKFLOW_RUN,
  TOOL_GITHUB_RERUN_WORKFLOW_RUN,
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
  TOOL_GOAL_MANAGE,
  TOOL_GOAL_CREATE,
  TOOL_AUTOMATION_CREATE,
  TOOL_COMPRESS,
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
    expect(TOOL_WORKTREE_ENTER).toBe("worktree_enter");
    expect(TOOL_WORKTREE_EXIT).toBe("worktree_exit");
    expect(TOOL_GITHUB_GET_PULL_REQUEST).toBe("github_get_pull_request");
    expect(TOOL_GITHUB_LIST_PULL_REQUESTS).toBe("github_list_pull_requests");
    expect(TOOL_GITHUB_GET_PULL_REQUEST_CHECKS).toBe("github_get_pull_request_checks");
    expect(TOOL_GITHUB_LIST_ISSUE_COMMENTS).toBe("github_list_issue_comments");
    expect(TOOL_GITHUB_CREATE_ISSUE_COMMENT).toBe("github_create_issue_comment");
    expect(TOOL_GITHUB_LIST_WORKFLOW_RUNS).toBe("github_list_workflow_runs");
    expect(TOOL_GITHUB_GET_WORKFLOW_RUN).toBe("github_get_workflow_run");
    expect(TOOL_GITHUB_RERUN_WORKFLOW_RUN).toBe("github_rerun_workflow_run");
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
    expect(TOOL_GOAL_MANAGE).toBe("goal_manage");
    expect(TOOL_GOAL_CREATE).toBe("goal_create");
    expect(TOOL_AUTOMATION_CREATE).toBe("automation_create");
    expect(TOOL_COMPRESS).toBe("compress");
  });

  test("Goal builtin surface exposes confirmed creation and managed lifecycle", () => {
    const activeGoalNames = ALL_BUILTIN_NAMES.filter((name) => name.startsWith("goal_"));

    expect(activeGoalNames).toEqual([TOOL_GOAL_MANAGE, TOOL_GOAL_CREATE]);
    expect(activeGoalNames).not.toContain("goal_lock");
    expect(activeGoalNames).not.toContain("goal_run");
    expect(activeGoalNames).not.toContain("goal_retry");
    expect(activeGoalNames).not.toContain("goal_check_done");
    expect(activeGoalNames).not.toContain("goal_evidence");
    expect(activeGoalNames).not.toContain("goal_artifact_read");
    expect(activeGoalNames).not.toContain("goal_artifact_write");
  });
});

describe("TOOL_CATEGORY_MAP", () => {
  test("all builtin names map to a non-other category", () => {
    for (const name of ALL_BUILTIN_NAMES) {
      const cat = TOOL_CATEGORY_MAP[name];
      expect(cat).toBeDefined();
      if (name === TOOL_COMPRESS) expect(cat).toBe("other");
      else expect(cat).not.toBe("other");
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
    expect(TOOL_CATEGORY_MAP[TOOL_WORKTREE_ENTER]).toBe("git");
    expect(TOOL_CATEGORY_MAP[TOOL_WORKTREE_EXIT]).toBe("git");
    expect(TOOL_CATEGORY_MAP[TOOL_GITHUB_GET_PULL_REQUEST]).toBe("git");
    expect(TOOL_CATEGORY_MAP[TOOL_GITHUB_CREATE_ISSUE_COMMENT]).toBe("git");
    expect(TOOL_CATEGORY_MAP[TOOL_GITHUB_RERUN_WORKFLOW_RUN]).toBe("git");
    expect(TOOL_CATEGORY_MAP[TOOL_BASH]).toBe("shell");
    expect(TOOL_CATEGORY_MAP[TOOL_WEB_FETCH]).toBe("web");
    expect(TOOL_CATEGORY_MAP[TOOL_SKILL_LIST]).toBe("skill");
    expect(TOOL_CATEGORY_MAP[TOOL_MEMORY_READ]).toBe("memory");
    expect(TOOL_CATEGORY_MAP[TOOL_GOAL_MANAGE]).toBe("goal");
    expect(TOOL_CATEGORY_MAP[TOOL_AUTOMATION_CREATE]).toBe("automation");
    expect(TOOL_CATEGORY_MAP[TOOL_COMPRESS]).toBe("other");
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
    expect(getToolCategory("worktree_enter")).toBe("git");
    expect(getToolCategory("worktree_exit")).toBe("git");
    expect(getToolCategory("github_get_pull_request")).toBe("git");
    expect(getToolCategory("github_create_issue_comment")).toBe("git");
    expect(getToolCategory("github_rerun_workflow_run")).toBe("git");
    expect(getToolCategory("workflow_create")).toBe("other");
    expect(getToolCategory("workflow_update_stage")).toBe("other");
    expect(getToolCategory("artifact_read")).toBe("other");
    expect(getToolCategory("artifact_write")).toBe("other");
    expect(getToolCategory("goal_create")).toBe("goal");
    expect(getToolCategory("goal_lock")).toBe("other");
    expect(getToolCategory("goal_run")).toBe("other");
    expect(getToolCategory("goal_retry")).toBe("other");
    expect(getToolCategory("goal_check_done")).toBe("other");
    expect(getToolCategory("goal_manage")).toBe("goal");
    expect(getToolCategory("goal_evidence")).toBe("other");
    expect(getToolCategory("goal_artifact_read")).toBe("other");
    expect(getToolCategory("goal_artifact_write")).toBe("other");
    expect(getToolCategory("compress")).toBe("other");
  });
});

describe("isBuiltinToolName()", () => {
  test("returns true for known builtin names", () => {
    expect(isBuiltinToolName("file_read")).toBe(true);
    expect(isBuiltinToolName("grep")).toBe(true);
    expect(isBuiltinToolName("workflow_update_stage")).toBe(false);
    expect(isBuiltinToolName("artifact_read")).toBe(false);
    expect(isBuiltinToolName("ast_grep_replace")).toBe(true);
    expect(isBuiltinToolName("github_get_pull_request")).toBe(true);
    expect(isBuiltinToolName("github_create_issue_comment")).toBe(true);
    expect(isBuiltinToolName("github_rerun_workflow_run")).toBe(true);
    expect(isBuiltinToolName("goal_manage")).toBe(true);
    expect(isBuiltinToolName("goal_evidence")).toBe(false);
    expect(isBuiltinToolName("goal_artifact_read")).toBe(false);
    expect(isBuiltinToolName("goal_artifact_write")).toBe(false);
    expect(isBuiltinToolName("compress")).toBe(true);
  });

  test("returns false for unknown names", () => {
    expect(isBuiltinToolName("mcp__foo")).toBe(false);
    expect(isBuiltinToolName("unknown_tool")).toBe(false);
    expect(isBuiltinToolName("")).toBe(false);
  });

  test("returns false for removed Goal executable names", () => {
    expect(isBuiltinToolName("goal_create")).toBe(true);
    expect(isBuiltinToolName("goal_lock")).toBe(false);
    expect(isBuiltinToolName("goal_run")).toBe(false);
    expect(isBuiltinToolName("goal_retry")).toBe(false);
    expect(isBuiltinToolName("goal_check_done")).toBe(false);
  });

  test("acts as a type guard narrowing to BuiltinToolName", () => {
    const name: string = "file_read";
    if (isBuiltinToolName(name)) {
      const cat: "fileRead" | "fileWrite" | "search" | "git" | "shell" | "interaction" | "lsp" | "web" | "delegation" | "skill" | "memory" | "goal" | "automation" | "mcp" | "other" = TOOL_CATEGORY_MAP[name];
      expect(cat).toBe("fileRead");
    }
  });
});
