import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  SKILL_TOOLS,
} from "../constants";
import {
  agentDefinitions,
  buildAgentDefinition,
  exploreAgentDefinition,
  librarianAgentDefinition,
  orchestratorAgentDefinition,
  planAgentDefinition,
  reviewerAgentDefinition,
} from "./index";
import {
  TOOL_AST_GREP_REPLACE,
  TOOL_BASH,
  TOOL_COMPRESS,
  TOOL_DELEGATE,
  TOOL_FILE_EDIT,
  TOOL_FILE_WRITE,
  TOOL_GOAL_MANAGE,
} from "../../tools/names";

const REQUIRED_AGENT_NAMES = [
  "orchestrator",
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
  "goal_create",
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
  test("exports exactly the six goal-era agent definitions", () => {
    expect(agentDefinitions.map((definition) => definition.name)).toEqual([...REQUIRED_AGENT_NAMES]);
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

  test("orchestrator owns Goal orchestration and delegates to all five child roles", () => {
    const tools = orchestratorAgentDefinition.tools.tools;

    expect(tools).toContain(TOOL_GOAL_MANAGE);
    expect(tools).toContain(TOOL_GOAL_MANAGE);
    expect(tools).toContain(TOOL_COMPRESS);
    expect(tools).toContain(TOOL_DELEGATE);
    expect(orchestratorAgentDefinition.tools.delegateTargets).toEqual([
      "plan",
      "build",
      "reviewer",
      "explore",
      "librarian",
    ]);
    expect(orchestratorAgentDefinition.mcpTools).toEqual(["context7", "exa"]);
    expect(orchestratorAgentDefinition.rolePrompt).toContain("## Goal Role: Orchestrator");
    expect(orchestratorAgentDefinition.rolePrompt).toContain("goal_manage");
    expect(orchestratorAgentDefinition.rolePrompt).toContain("action=create");
    expect(orchestratorAgentDefinition.rolePrompt).toContain("action=start");
    expect(orchestratorAgentDefinition.rolePrompt).toContain("action=begin_review");
    expect(orchestratorAgentDefinition.rolePrompt).toContain("action=retry");
    expect(orchestratorAgentDefinition.rolePrompt).not.toContain("goal_create");
    expect(orchestratorAgentDefinition.rolePrompt).not.toContain("goal_lock");
    expect(orchestratorAgentDefinition.rolePrompt).not.toContain("goal_run");
    expect(orchestratorAgentDefinition.rolePrompt).not.toContain("goal_retry");
    expect(orchestratorAgentDefinition.rolePrompt).not.toContain("goal_check_done");
    expect(orchestratorAgentDefinition.rolePrompt).not.toContain("goal_manage.finalize_review");
    expect(orchestratorAgentDefinition.rolePrompt).not.toContain("finalize_review");
    expect(orchestratorAgentDefinition.rolePrompt).not.toContain("workflow_create");
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

  test("Reviewer can verify goals but cannot mutate source", () => {
    const tools = reviewerAgentDefinition.tools.tools;

    expect(tools).toContain(TOOL_GOAL_MANAGE);
    expect(tools).toContain("git_diff");
    expect(tools).toContain("grep");
    expect(tools).toContain("glob");
    expect(tools).toContain("lsp_diagnostics");
    expect(tools).toContain(TOOL_COMPRESS);
    expectNoTools(tools, SOURCE_WRITE_TOOLS);
    expect(reviewerAgentDefinition.tools.delegateTargets).toEqual(["explore", "librarian"]);
  });

  test("Goal lifecycle and evidence tools are limited to intended roles", () => {
    const goalManageAgents = agentDefinitions
      .filter((definition) => (definition.tools.tools as readonly string[]).includes(TOOL_GOAL_MANAGE))
      .map((definition) => definition.name);

    expect(goalManageAgents).toEqual(["orchestrator", "reviewer"]);
  });

  test("Reviewer prompt is default-deny and includes the required five-point checklist", () => {
    const prompt = reviewerAgentDefinition.rolePrompt;

    expect(prompt).toContain("Default stance: NOT_DONE");
    for (const item of ["Scope", "Intent", "Tests", "No cheating", "Risk"] as const) {
      expect(prompt).toContain(item);
    }
    expect(prompt).toContain("DONE");
    expect(prompt).toContain("NOT_DONE");
    expect(prompt).not.toContain("ESCALATE_HUMAN");
    expect(prompt).toContain("goal_manage.finalize_review");
    expect(prompt).toContain("DONE requires evidence");
    expect(prompt).toContain("Insufficient evidence means NOT_DONE");
    expect(prompt).not.toContain("goal_check_done");
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

  test("core delegation depth policies match orchestrator → core → ancillary", () => {
    expect(orchestratorAgentDefinition.childPolicy).toEqual({
      maxDepth: 3,
      maxConcurrent: MAX_CONCURRENT_SUB_AGENTS,
      timeoutMs: DEFAULT_SUB_AGENT_TIMEOUT_MS,
      abortCascade: true,
      terminalReminders: true,
    });

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

    test("allocation matrix matches the six-agent architecture", () => {
      expect(orchestratorAgentDefinition.skills).toEqual([
        "git-master",
        "safe-refactor",
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
      expect(exploreAgentDefinition.skills).toEqual(["codemap", "research-docs"]);
      expect(librarianAgentDefinition.skills).toEqual(["codemap", "research-docs"]);
    });
  });
});
