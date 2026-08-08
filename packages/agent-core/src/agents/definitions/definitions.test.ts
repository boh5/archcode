import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  SKILL_ACCESS_TOOLS,
} from "../constants";
import {
  agentDefinitions,
  analystAgentDefinition,
  buildAgentDefinition,
  discussionAgentDefinition,
  exploreAgentDefinition,
  leadAgentDefinition,
  librarianAgentDefinition,
} from "./index";
import {
  TOOL_COMPRESS,
} from "../../tools/names";
import { BUILTIN_SKILL_PACKAGES } from "../../skills";

const EXPECTED_TOOL_MATRIX = {
  lead: [
    "file_read",
    "pdf_read",
    "file_write",
    "file_edit",
    "grep",
    "glob",
    "ast_grep_search",
    "ast_grep_replace",
    "git_status",
    "git_diff",
    "bash",
    "todo_write",
    "ask_user",
    "lsp_diagnostics",
    "lsp_goto_definition",
    "lsp_find_references",
    "lsp_symbols",
    "web_fetch",
    "delegate",
    "resume_session",
    "background_output",
    "wait_for_reminder",
    "cancel_session",
    "output_read",
    "output_search",
    "compress",
    "memory_read",
    "memory_write",
    "create_goal",
    "get_goal",
    "update_goal",
    "automation_create",
    "skill_list",
    "skill_read",
  ],
  discussion: [
    "file_read",
    "pdf_read",
    "file_write",
    "file_edit",
    "grep",
    "glob",
    "ast_grep_search",
    "git_status",
    "git_diff",
    "bash",
    "todo_write",
    "ask_user",
    "lsp_diagnostics",
    "lsp_goto_definition",
    "lsp_find_references",
    "lsp_symbols",
    "web_fetch",
    "memory_read",
    "memory_write",
    "project_todo_update",
    "delegate",
    "resume_session",
    "background_output",
    "wait_for_reminder",
    "output_read",
    "output_search",
    "compress",
    "skill_list",
    "skill_read",
  ],
  analyst: [
    "file_read",
    "pdf_read",
    "grep",
    "glob",
    "git_status",
    "git_diff",
    "bash",
    "ast_grep_search",
    "lsp_diagnostics",
    "lsp_goto_definition",
    "lsp_find_references",
    "lsp_symbols",
    "web_fetch",
    "ask_user",
    "memory_read",
    "todo_write",
    "delegate",
    "resume_session",
    "background_output",
    "wait_for_reminder",
    "output_read",
    "output_search",
    "compress",
    "skill_list",
    "skill_read",
  ],
  build: [
    "file_read",
    "pdf_read",
    "file_write",
    "file_edit",
    "grep",
    "glob",
    "ast_grep_search",
    "ast_grep_replace",
    "git_status",
    "git_diff",
    "bash",
    "todo_write",
    "ask_user",
    "lsp_diagnostics",
    "lsp_goto_definition",
    "lsp_find_references",
    "lsp_symbols",
    "web_fetch",
    "delegate",
    "resume_session",
    "background_output",
    "wait_for_reminder",
    "output_read",
    "output_search",
    "compress",
    "memory_read",
    "memory_write",
    "skill_list",
    "skill_read",
  ],
  explore: [
    "file_read",
    "pdf_read",
    "grep",
    "glob",
    "git_status",
    "git_diff",
    "ast_grep_search",
    "lsp_diagnostics",
    "lsp_goto_definition",
    "lsp_find_references",
    "lsp_symbols",
    "output_read",
    "output_search",
    "todo_write",
    "compress",
    "skill_list",
    "skill_read",
  ],
  librarian: [
    "file_read",
    "pdf_read",
    "grep",
    "glob",
    "web_fetch",
    "memory_read",
    "output_read",
    "output_search",
    "todo_write",
    "compress",
    "skill_list",
    "skill_read",
  ],
} as const;

describe("Agent catalog", () => {
  test("defines five execution Agents plus the Todo Discussion entry Agent", () => {
    expect(agentDefinitions.map(({ name, displayName }) => ({ name, displayName }))).toEqual([
      { name: "lead", displayName: "Lead" },
      { name: "discussion", displayName: "Discussion" },
      { name: "analyst", displayName: "Analyst" },
      { name: "build", displayName: "Build" },
      { name: "explore", displayName: "Explore" },
      { name: "librarian", displayName: "Librarian" },
    ]);
    expect(new Set(agentDefinitions.map((definition) => definition.name)).size).toBe(6);
  });

  test("binds each identity to only its valid Profile choices", () => {
    expect(leadAgentDefinition.profiles).toEqual(["principal"]);
    expect(discussionAgentDefinition.profiles).toEqual(["principal"]);
    expect(analystAgentDefinition.profiles).toEqual(["deep"]);
    expect(buildAgentDefinition.profiles).toEqual(["deep", "fast"]);
    expect(exploreAgentDefinition.profiles).toEqual(["fast"]);
    expect(librarianAgentDefinition.profiles).toEqual(["fast"]);
  });

  test("preserves the locked target and depth matrix", () => {
    expect(leadAgentDefinition.tools.delegateTargets).toEqual(["analyst", "build", "explore", "librarian"]);
    expect(discussionAgentDefinition.tools.delegateTargets).toEqual(["explore", "librarian"]);
    expect(discussionAgentDefinition.mcpTools).toEqual([]);
    expect(analystAgentDefinition.tools.delegateTargets).toEqual(["explore", "librarian"]);
    expect(buildAgentDefinition.tools.delegateTargets).toEqual(["explore"]);
    expect("delegateTargets" in exploreAgentDefinition.tools).toBe(false);
    expect("delegateTargets" in librarianAgentDefinition.tools).toBe(false);

    for (const [definition, maxDepth] of [
      [leadAgentDefinition, 3],
      [discussionAgentDefinition, 2],
      [analystAgentDefinition, 2],
      [buildAgentDefinition, 2],
    ] as const) {
      expect(definition.childPolicy).toEqual({
        maxDepth,
        maxConcurrent: MAX_CONCURRENT_SUB_AGENTS,
        timeoutMs: DEFAULT_SUB_AGENT_TIMEOUT_MS,
        abortCascade: true,
        terminalReminders: true,
      });
    }
  });

  test("locks the exact ordered tool authority matrix for every Agent", () => {
    expect(Object.fromEntries(
      agentDefinitions.map((definition) => [definition.name, [...definition.tools.tools]]),
    ) as unknown).toEqual(EXPECTED_TOOL_MATRIX);
  });

  test("keeps Skills guidance-only and core lifecycle manuals available", () => {
    for (const definition of agentDefinitions) {
      expect(definition.tools.tools).toContain(TOOL_COMPRESS);
      for (const tool of SKILL_ACCESS_TOOLS) expect(definition.tools.tools).toContain(tool);
      expect("allowedTools" in definition).toBe(false);
    }

    for (const name of ["orchestrate-work", "plan-work", "execute-plan", "run-goal", "shape-todo", "review-work", "goal-review"] as const) {
      expect(BUILTIN_SKILL_PACKAGES[name].entry).toBeString();
    }
    expect(leadAgentDefinition.skills).toEqual(expect.arrayContaining([
      "orchestrate-work", "plan-work", "execute-plan", "run-goal", "review-work",
    ]));
    expect(leadAgentDefinition.skills).not.toContain("shape-todo");
    expect(discussionAgentDefinition.skills).toEqual(expect.arrayContaining([
      "shape-todo", "plan-work",
    ]));
    expect(analystAgentDefinition.skills).toEqual(expect.arrayContaining([
      "analyze-work", "review-change", "goal-review",
    ]));
    expect(buildAgentDefinition.skills).not.toContain("review-work");
  });

  test("Role contracts contain stable boundaries rather than workflow recipes", () => {
    expect(leadAgentDefinition.roleContract.delegateTargets).toEqual(["analyst", "build", "explore", "librarian"]);
    expect(discussionAgentDefinition.roleContract.delegateTargets).toEqual(["explore", "librarian"]);
    expect(discussionAgentDefinition.roleContract.forbiddenCapabilities).toEqual(expect.arrayContaining([
      "ast_grep_replace", "create_goal", "update_goal", "automation_create",
    ]));
    expect(analystAgentDefinition.roleContract.forbiddenCapabilities).toEqual(expect.arrayContaining([
      "file_write", "file_edit", "ast_grep_replace",
    ]));
  });
});
