import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  SKILL_ACCESS_TOOLS,
} from "../constants";
import {
  agentDefinitions,
  buildAgentDefinition,
  engineerAgentDefinition,
  exploreAgentDefinition,
  librarianAgentDefinition,
  planAgentDefinition,
  reviewerAgentDefinition,
  shaperAgentDefinition,
} from "./index";
import {
  TOOL_AST_GREP_REPLACE,
  TOOL_AST_GREP_SEARCH,
  TOOL_ASK_USER,
  TOOL_BASH,
  TOOL_COMPRESS,
  TOOL_DELEGATE,
  TOOL_FILE_EDIT,
  TOOL_FILE_READ,
  TOOL_FILE_WRITE,
  TOOL_CREATE_GOAL,
  TOOL_GET_GOAL,
  TOOL_UPDATE_GOAL,
  TOOL_PROJECT_TODO_UPDATE,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LSP_DIAGNOSTICS,
  TOOL_MEMORY_READ,
  TOOL_MEMORY_WRITE,
  TOOL_TODO_WRITE,
  TOOL_WEB_FETCH,
} from "../../tools/names";

const REQUIRED_AGENT_NAMES = [
  "engineer",
  "plan",
  "build",
  "reviewer",
  "explore",
  "librarian",
  "shaper",
] as const;

const WORKFLOW_TOOLS = [
  "workflow_create",
  "workflow_read",
  "workflow_update_stage",
  "workflow_propose_interactions",
  "workflow_request_interactions",
  "workflow_task_check",
  "artifact_read",
  "artifact_write",
] as const;

const REMOVED_GOAL_EXECUTABLE_TOOL_NAMES = [
  "goal_lock",
  "goal_run",
  "goal_retry",
  "goal_check_done",
] as const;

const SOURCE_WRITE_TOOLS = [
  TOOL_FILE_WRITE,
  TOOL_FILE_EDIT,
  TOOL_BASH,
  TOOL_AST_GREP_REPLACE,
] as const;

const GITHUB_CONNECTOR_TOOLS = [
  "github_get_pull_request",
  "github_list_pull_requests",
  "github_get_pull_request_checks",
  "github_list_issue_comments",
  "github_create_issue_comment",
  "github_list_workflow_runs",
  "github_get_workflow_run",
  "github_rerun_workflow_run",
] as const;

function expectNoTools(tools: readonly string[], forbidden: readonly string[]) {
  for (const tool of forbidden) expect(tools).not.toContain(tool);
}

describe("agentDefinitions", () => {
  test("exports the closed seven-agent registry with stable display names", () => {
    expect(agentDefinitions.map((definition) => definition.name)).toEqual([...REQUIRED_AGENT_NAMES]);
    expect(agentDefinitions.map(({ name, displayName }) => ({ name, displayName }))).toEqual([
      { name: "engineer", displayName: "Engineer" },
      { name: "plan", displayName: "Plan" },
      { name: "build", displayName: "Build" },
      { name: "reviewer", displayName: "Reviewer" },
      { name: "explore", displayName: "Explore" },
      { name: "librarian", displayName: "Librarian" },
      { name: "shaper", displayName: "Shaper" },
    ]);
    expect(new Set(agentDefinitions.map((definition) => definition.name)).size).toBe(agentDefinitions.length);
  });

  test("legacy workflow role definitions are not in the active registry", () => {
    const names = agentDefinitions.map((definition) => definition.name);

    expect(names).not.toContain("product");
    expect(names).not.toContain("spec");
    expect(names).not.toContain("critic");
    expect(names).not.toContain("foreman");
    expect(names).not.toContain("builder");
  });

  test("all active definitions are free of Workflow and artifact tools", () => {
    for (const definition of agentDefinitions) {
      expectNoTools(definition.tools.tools, WORKFLOW_TOOLS);
    }
  });

  test("all active definitions omit removed Goal executable tool names", () => {
    for (const definition of agentDefinitions) {
      expectNoTools(definition.tools.tools, REMOVED_GOAL_EXECUTABLE_TOOL_NAMES);
      for (const toolName of REMOVED_GOAL_EXECUTABLE_TOOL_NAMES) {
        expect(JSON.stringify(definition.roleContract)).not.toContain(toolName);
      }
    }
  });

  test("default active definitions do not expose GitHub connector tools", () => {
    for (const definition of agentDefinitions) {
      expectNoTools(definition.tools.tools, GITHUB_CONNECTOR_TOOLS);
    }
  });

  test("Engineer owns ordinary and active-Goal Sessions", () => {
    const tools = engineerAgentDefinition.tools.tools;

    for (const tool of SOURCE_WRITE_TOOLS) expect(tools).toContain(tool);
    expect(tools).toContain(TOOL_CREATE_GOAL);
    expect(tools).toContain(TOOL_GET_GOAL);
    expect(tools).toContain(TOOL_UPDATE_GOAL);
    expect(tools).toContain("automation_create");
    expect(engineerAgentDefinition.skills).not.toContain("goal-create");
    expect(engineerAgentDefinition.skills).toContain("automation-create");
    expect(tools).toContain(TOOL_COMPRESS);
    expect(tools).toContain(TOOL_DELEGATE);
    expect(engineerAgentDefinition.tools.delegateTargets).toEqual([
      "plan",
      "build",
      "reviewer",
      "explore",
      "librarian",
    ]);
  });

  test("Plan has read-only planning tools, Context7 MCP, and research-only delegation", () => {
    const tools = planAgentDefinition.tools.tools;

    expect(tools).toContain("file_read");
    expect(tools).toContain("grep");
    expect(tools).toContain("glob");
    expect(tools).toContain("web_fetch");
    expect(tools).toContain("lsp_diagnostics");
    expect(tools).toContain(TOOL_COMPRESS);
    expectNoTools(tools, SOURCE_WRITE_TOOLS);
    expect(planAgentDefinition.mcpTools).toEqual(["context7"]);
    expect(planAgentDefinition.tools.delegateTargets).toEqual(["explore", "librarian"]);
  });

  test("Build is the only source-writing implementation role", () => {
    const tools = buildAgentDefinition.tools.tools;

    for (const tool of SOURCE_WRITE_TOOLS) expect(tools).toContain(tool);
    expect(tools).toContain(TOOL_COMPRESS);
    expect("mcpTools" in buildAgentDefinition).toBe(false);
    expect(buildAgentDefinition.tools.delegateTargets).toEqual(["explore"]);
  });

  test("Reviewer can verify goals with non-mutating Bash but cannot ask or mutate source", () => {
    const tools = reviewerAgentDefinition.tools.tools;

    expect(tools).not.toContain("goal_manage");
    expect(tools).toContain("git_diff");
    expect(tools).toContain("grep");
    expect(tools).toContain("glob");
    expect(tools).toContain("lsp_diagnostics");
    expect(tools).toContain(TOOL_BASH);
    expect(tools).toContain(TOOL_COMPRESS);
    expectNoTools(tools, [TOOL_FILE_WRITE, TOOL_FILE_EDIT, TOOL_AST_GREP_REPLACE, TOOL_ASK_USER]);
    expect(reviewerAgentDefinition.tools.delegateTargets).toEqual(["explore", "librarian"]);
  });

  test("Shaper owns Todo shaping without implementation or creation capabilities", () => {
    const tools = shaperAgentDefinition.tools.tools;

    for (const tool of [
      TOOL_FILE_READ,
      TOOL_GREP,
      TOOL_GLOB,
      TOOL_AST_GREP_SEARCH,
      TOOL_LSP_DIAGNOSTICS,
      TOOL_WEB_FETCH,
      TOOL_BASH,
      TOOL_ASK_USER,
      TOOL_MEMORY_READ,
      TOOL_MEMORY_WRITE,
      TOOL_TODO_WRITE,
      TOOL_PROJECT_TODO_UPDATE,
    ] as const) expect(tools).toContain(tool);
    expectNoTools(tools, [
      TOOL_FILE_WRITE,
      TOOL_FILE_EDIT,
      TOOL_AST_GREP_REPLACE,
      "create_goal",
      "get_goal",
      "update_goal",
      "automation_create",
      "goal_manage",
    ]);
    expect(shaperAgentDefinition.tools.delegateTargets).toEqual(["explore", "librarian"]);
    expect(shaperAgentDefinition.hooks.memoryExtraction).toBe(false);
    expect(shaperAgentDefinition.hooks.memoryConsolidation).toBe(false);
    expect(shaperAgentDefinition.roleContract.completionAuthority).toEqual(["bound-todo"]);
    expect(shaperAgentDefinition.roleContract.allowedTransitions.default).toEqual(["todo.update"]);
    expect(shaperAgentDefinition.roleContract.forbiddenBehaviors.join(" ")).toContain("Do not implement");
  });

  test("only Engineer sees Session Goal control tools", () => {
    for (const definition of agentDefinitions) {
      const tools = definition.tools.tools as readonly string[];
      for (const tool of [TOOL_CREATE_GOAL, TOOL_GET_GOAL, TOOL_UPDATE_GOAL]) {
        expect(tools.includes(tool), `${definition.name}/${tool}`).toBe(definition.name === "engineer");
      }
      expect(tools).not.toContain("goal_create");
      expect(tools).not.toContain("goal_manage");
    }
  });

  test("audits the complete role-sensitive capability matrix from real definitions", () => {
    const capabilityNames = [
      "output_read",
      "output_search",
      "cancel_session",
      "bash",
      "memory_read",
      "memory_write",
      "file_write",
      "file_edit",
      "ast_grep_replace",
      "create_goal",
      "get_goal",
      "update_goal",
      "delegate",
      "skill_list",
      "skill_read",
    ] as const;
    const expected = {
      engineer: ["output_read", "output_search", "cancel_session", "bash", "memory_read", "memory_write", "file_write", "file_edit", "ast_grep_replace", "create_goal", "get_goal", "update_goal", "delegate", "skill_list", "skill_read"],
      plan: ["output_read", "output_search", "memory_read", "delegate", "skill_list", "skill_read"],
      build: ["output_read", "output_search", "bash", "memory_read", "memory_write", "file_write", "file_edit", "ast_grep_replace", "delegate", "skill_list", "skill_read"],
      reviewer: ["output_read", "output_search", "bash", "memory_read", "delegate", "skill_list", "skill_read"],
      explore: ["output_read", "output_search", "skill_list", "skill_read"],
      librarian: ["output_read", "output_search", "memory_read", "skill_list", "skill_read"],
      shaper: ["output_read", "output_search", "bash", "memory_read", "memory_write", "delegate", "skill_list", "skill_read"],
    } as const;

    for (const definition of agentDefinitions) {
      const actual = capabilityNames.filter((tool) => (
        definition.tools.tools as readonly string[]
      ).includes(tool));
      expect(actual, definition.name).toEqual([...expected[definition.name]]);
    }
  });

  test("Explore and Librarian are ancillary read-only agents with no delegation", () => {
    for (const definition of [exploreAgentDefinition, librarianAgentDefinition]) {
      expectNoTools(definition.tools.tools, SOURCE_WRITE_TOOLS);
      expectNoTools(definition.tools.tools, ["goal_manage"]);
      expect(definition.tools.tools).toContain(TOOL_COMPRESS);
      expect("delegateTargets" in definition.tools).toBe(false);
      expect("childPolicy" in definition).toBe(false);
      expect(definition.tools.tools).not.toContain(TOOL_DELEGATE);
    }

    expect("mcpTools" in exploreAgentDefinition).toBe(false);
    expect(librarianAgentDefinition.mcpTools).toEqual(["context7", "grep.app", "exa"]);
  });

  test("delegated roles expose the canonical child result submission tool", () => {
    const withSubmit = agentDefinitions
      .filter((definition) => (definition.tools.tools as readonly string[]).includes("submit_child_result"))
      .map((definition) => definition.name);
    expect(withSubmit).toEqual(["plan", "build", "reviewer", "explore", "librarian"]);
  });

  test("ask_user belongs to interactive working and shaping roles", () => {
    for (const definition of [engineerAgentDefinition, planAgentDefinition, buildAgentDefinition, shaperAgentDefinition]) {
      expect(definition.tools.tools).toContain(TOOL_ASK_USER);
    }

    for (const definition of [reviewerAgentDefinition, librarianAgentDefinition]) {
      expect(definition.tools.tools).not.toContain(TOOL_ASK_USER);
    }
  });

  test("only Explore omits long-term memory from its prompt", () => {
    expect(exploreAgentDefinition.includeMemoryInPrompt).toBe(false);
    for (const definition of [
      engineerAgentDefinition,
      planAgentDefinition,
      buildAgentDefinition,
      reviewerAgentDefinition,
      librarianAgentDefinition,
      shaperAgentDefinition,
    ]) {
      expect(definition.includeMemoryInPrompt).toBe(true);
    }
  });

  test("principal delegation depth policies match principal → core → ancillary", () => {
    for (const definition of [engineerAgentDefinition]) {
      expect(definition.childPolicy).toEqual({
        maxDepth: 3,
        maxConcurrent: MAX_CONCURRENT_SUB_AGENTS,
        timeoutMs: DEFAULT_SUB_AGENT_TIMEOUT_MS,
        abortCascade: true,
        terminalReminders: true,
      });
    }

    for (const definition of [planAgentDefinition, buildAgentDefinition, reviewerAgentDefinition, shaperAgentDefinition]) {
      expect(definition.childPolicy).toEqual({
        maxDepth: 2,
        maxConcurrent: MAX_CONCURRENT_SUB_AGENTS,
        timeoutMs: DEFAULT_SUB_AGENT_TIMEOUT_MS,
        abortCascade: true,
        terminalReminders: true,
      });
    }
  });

  test("definitions do not expose target-side canBeDelegated", () => {
    for (const definition of agentDefinitions) {
      expect("canBeDelegated" in definition).toBe(false);
      expect("canBeDelegated" in definition.tools).toBe(false);
    }
  });

  test("all active definitions have automatic compact hooks and active compress access", () => {
    for (const definition of agentDefinitions) {
      expect(definition.hooks.autoCompact).toBe(true);
      expect(definition.tools.tools).toContain(TOOL_COMPRESS);
      expect(definition.tools.tools).not.toContain("compact");
    }
  });

  const KNOWN_SKILLS = [
    "git-master",
    "safe-refactor",
    "codemap",
    "review-work",
    "research-docs",
    "automation-create",
  ] as const;

  describe("skills", () => {
    test("all definitions have valid explicit skills and include skill tools when needed", () => {
      for (const definition of agentDefinitions) {
        expect(Array.isArray(definition.skills)).toBe(true);
        for (const skill of definition.skills) expect(KNOWN_SKILLS).toContain(skill);
        if (definition.skills.length > 0) {
          for (const skillTool of SKILL_ACCESS_TOOLS) expect(definition.tools.tools).toContain(skillTool);
        }
      }
    });

    test("allocation matrix matches the seven-agent architecture", () => {
      expect(engineerAgentDefinition.skills).toEqual([
        "git-master",
        "safe-refactor",
        "codemap",
        "review-work",
        "research-docs",
        "automation-create",
      ]);
      expect(planAgentDefinition.skills).toEqual(["codemap", "research-docs"]);
      expect(buildAgentDefinition.skills).toEqual([
        "git-master",
        "safe-refactor",
        "codemap",
        "review-work",
        "research-docs",
      ]);
      expect(reviewerAgentDefinition.skills).toEqual([
        "codemap",
        "safe-refactor",
        "review-work",
        "research-docs",
      ]);
      expect(exploreAgentDefinition.skills).toEqual(["codemap"]);
      expect(librarianAgentDefinition.skills).toEqual(["codemap", "research-docs"]);
      expect(shaperAgentDefinition.skills).toEqual(["codemap", "research-docs"]);
    });
  });
});
