import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  SKILL_TOOLS,
} from "../constants";
import {
  agentDefinitions,
  buildAgentDefinition,
  engineerAgentDefinition,
  exploreAgentDefinition,
  goalLeadAgentDefinition,
  librarianAgentDefinition,
  planAgentDefinition,
  reviewerAgentDefinition,
} from "./index";
import {
  TOOL_AST_GREP_REPLACE,
  TOOL_ASK_USER,
  TOOL_BASH,
  TOOL_COMPRESS,
  TOOL_DELEGATE,
  TOOL_FILE_EDIT,
  TOOL_FILE_WRITE,
  TOOL_GOAL_MANAGE,
} from "../../tools/names";

const REQUIRED_AGENT_NAMES = [
  "engineer",
  "goal_lead",
  "plan",
  "build",
  "reviewer",
  "explore",
  "librarian",
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
      { name: "goal_lead", displayName: "Goal Lead" },
      { name: "plan", displayName: "Plan" },
      { name: "build", displayName: "Build" },
      { name: "reviewer", displayName: "Reviewer" },
      { name: "explore", displayName: "Explore" },
      { name: "librarian", displayName: "Librarian" },
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
        expect(definition.rolePrompt).not.toContain(toolName);
      }
    }
  });

  test("default active definitions do not expose GitHub connector tools", () => {
    for (const definition of agentDefinitions) {
      expectNoTools(definition.tools.tools, GITHUB_CONNECTOR_TOOLS);
    }
  });

  test("Engineer owns ordinary engineering sessions and can create Goals", () => {
    const tools = engineerAgentDefinition.tools.tools;

    for (const tool of SOURCE_WRITE_TOOLS) expect(tools).toContain(tool);
    expect(tools).toContain("goal_create");
    expect(tools).not.toContain(TOOL_GOAL_MANAGE);
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

  test("Goal Lead is Goal-only, delegates all specialist work, and cannot mutate source", () => {
    const tools = goalLeadAgentDefinition.tools.tools;

    expect(tools).toContain(TOOL_GOAL_MANAGE);
    expect(tools).toContain(TOOL_COMPRESS);
    expect(tools).toContain(TOOL_DELEGATE);
    expectNoTools(tools, SOURCE_WRITE_TOOLS);
    expect(goalLeadAgentDefinition.tools.delegateTargets).toEqual([
      "plan",
      "build",
      "reviewer",
      "explore",
      "librarian",
    ]);
    expect(goalLeadAgentDefinition.mcpTools).toEqual(["context7", "exa"]);
    expect(goalLeadAgentDefinition.hooks.todoStepReminder).toBe(true);
    expect(goalLeadAgentDefinition.hooks.todoQueryLoopContinuation).toBe(false);
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
    expectNoTools(tools, [TOOL_GOAL_MANAGE]);
    expect(tools).toContain(TOOL_COMPRESS);
    expect("mcpTools" in buildAgentDefinition).toBe(false);
    expect(buildAgentDefinition.tools.delegateTargets).toEqual(["explore"]);
  });

  test("Reviewer can verify goals with non-mutating Bash but cannot ask or mutate source", () => {
    const tools = reviewerAgentDefinition.tools.tools;

    expect(tools).toContain(TOOL_GOAL_MANAGE);
    expect(tools).toContain("git_diff");
    expect(tools).toContain("grep");
    expect(tools).toContain("glob");
    expect(tools).toContain("lsp_diagnostics");
    expect(tools).toContain(TOOL_BASH);
    expect(tools).toContain(TOOL_COMPRESS);
    expectNoTools(tools, [TOOL_FILE_WRITE, TOOL_FILE_EDIT, TOOL_AST_GREP_REPLACE, TOOL_ASK_USER]);
    expect(reviewerAgentDefinition.tools.delegateTargets).toEqual(["explore", "librarian"]);
  });

  test("Goal lifecycle and evidence tools are limited to intended roles", () => {
    const goalManageAgents = agentDefinitions
      .filter((definition) => (definition.tools.tools as readonly string[]).includes(TOOL_GOAL_MANAGE))
      .map((definition) => definition.name);

    expect(goalManageAgents).toEqual(["goal_lead", "reviewer"]);
  });

  test("Explore and Librarian are ancillary read-only agents with no delegation", () => {
    for (const definition of [exploreAgentDefinition, librarianAgentDefinition]) {
      expectNoTools(definition.tools.tools, SOURCE_WRITE_TOOLS);
      expectNoTools(definition.tools.tools, [
        TOOL_GOAL_MANAGE,
      ]);
      expect(definition.tools.tools).toContain(TOOL_COMPRESS);
      expect("delegateTargets" in definition.tools).toBe(false);
      expect("childPolicy" in definition).toBe(false);
      expect(definition.tools.tools).not.toContain(TOOL_DELEGATE);
    }

    expect("mcpTools" in exploreAgentDefinition).toBe(false);
    expect(librarianAgentDefinition.mcpTools).toEqual(["context7", "grep.app", "exa"]);
  });

  test("ask_user belongs only to the four interactive working roles", () => {
    for (const definition of [engineerAgentDefinition, goalLeadAgentDefinition, planAgentDefinition, buildAgentDefinition]) {
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
      goalLeadAgentDefinition,
      planAgentDefinition,
      buildAgentDefinition,
      reviewerAgentDefinition,
      librarianAgentDefinition,
    ]) {
      expect(definition.includeMemoryInPrompt).toBe(true);
    }
  });

  test("principal delegation depth policies match principal → core → ancillary", () => {
    for (const definition of [engineerAgentDefinition, goalLeadAgentDefinition]) {
      expect(definition.childPolicy).toEqual({
        maxDepth: 3,
        maxConcurrent: MAX_CONCURRENT_SUB_AGENTS,
        timeoutMs: DEFAULT_SUB_AGENT_TIMEOUT_MS,
        abortCascade: true,
        terminalReminders: true,
      });
    }

    for (const definition of [planAgentDefinition, buildAgentDefinition, reviewerAgentDefinition]) {
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
  ] as const;

  describe("skills", () => {
    test("all definitions have valid explicit skills and include skill tools when needed", () => {
      for (const definition of agentDefinitions) {
        expect(Array.isArray(definition.skills)).toBe(true);
        for (const skill of definition.skills) expect(KNOWN_SKILLS).toContain(skill);
        if (definition.skills.length > 0) {
          for (const skillTool of SKILL_TOOLS) expect(definition.tools.tools).toContain(skillTool);
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
      ]);
      expect(goalLeadAgentDefinition.skills).toEqual([
        "codemap",
        "review-work",
        "research-docs",
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
    });
  });
});
