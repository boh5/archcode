import { describe, expect, test } from "bun:test";

import { defaultAgentDefinitions } from "../agents";
import { automationCreateTool } from "../tools/builtins/automation-create";
import { createBuiltinToolDescriptors } from "../tools/builtins";
import { createMemoryReadTool } from "../tools/builtins/memory-read";
import { createMemoryWriteTool } from "../tools/builtins/memory-write";
import { goalCreateTool, goalManageTool } from "../tools/builtins/goal-tools";
import { createGitHubToolDescriptors } from "../tools/github";
import { adaptMcpTool } from "../mcp/tool-adapter";
import type { McpClient } from "../mcp/client";
import { SecretRedactionPolicy } from "../security";

const SOURCE = [
  "file_read",
  "grep",
  "glob",
  "background_output",
  "output_read",
  "output_search",
] as const;

const INLINE = [
  "submit_child_result",
  "todo_write",
  "wait_for_reminder",
  "cancel_session",
  "skill_list",
  "memory_write",
  "goal_create",
  "goal_manage",
  "automation_create",
  "compress",
  "worktree_enter",
  "worktree_exit",
  "project_todo_update",
] as const;

const ARTIFACT = [
  "file_write",
  "file_edit",
  "ast_grep_search",
  "ast_grep_replace",
  "git_status",
  "git_diff",
  "bash",
  "ask_user",
  "lsp_diagnostics",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_symbols",
  "web_fetch",
  "delegate",
  "resume_session",
  "skill_read",
  "memory_read",
  "github_get_pull_request",
  "github_list_pull_requests",
  "github_get_pull_request_checks",
  "github_list_issue_comments",
  "github_create_issue_comment",
  "github_list_workflow_runs",
  "github_get_workflow_run",
  "github_rerun_workflow_run",
] as const;

describe("Tool Output Plane architecture matrix", () => {
  test("exhaustively classifies builtin, session-extra, and all eight GitHub descriptors", () => {
    const descriptors = [
      ...createBuiltinToolDescriptors(),
      createMemoryReadTool(),
      createMemoryWriteTool(),
      goalCreateTool,
      goalManageTool,
      automationCreateTool,
      ...createGitHubToolDescriptors({ connector: {} as never }),
    ];
    const actual = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor.outputPolicy.kind]));
    expect(actual.size).toBe(descriptors.length);

    const expected = new Map<string, "source" | "inline" | "artifact">([
      ...SOURCE.map((name) => [name, "source"] as const),
      ...INLINE.map((name) => [name, "inline"] as const),
      ...ARTIFACT.map((name) => [name, "artifact"] as const),
    ]);
    expect([...actual.entries()].sort()).toEqual([...expected.entries()].sort());
  });

  test("dynamic MCP adapters are explicitly artifact policy", () => {
    const descriptor = adaptMcpTool(
      { name: "lookup", inputSchema: { type: "object" } },
      "docs",
      { callTool: async () => ({ content: [] }) } as unknown as McpClient,
      new SecretRedactionPolicy([]),
    );
    expect(descriptor.name).toBe("mcp__docs__lookup");
    expect(descriptor.outputPolicy).toEqual({ kind: "artifact", previewDirection: "head-tail" });
  });

  test("all eight agents expose both recovery tools and no retired viewer", () => {
    expect(defaultAgentDefinitions).toHaveLength(8);
    for (const definition of defaultAgentDefinitions) {
      expect(definition.tools.tools).toContain("output_read");
      expect(definition.tools.tools).toContain("output_search");
      expect(definition.tools.tools).not.toContain("view_tool_output");
    }
  });
});
