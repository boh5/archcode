import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  EXPLORER_READ_ONLY_TOOLS,
  MAX_CONCURRENT_SUB_AGENTS,
  MAX_SUB_AGENT_DEPTH,
  SKILL_TOOLS,
} from "../constants";
import {
  agentDefinitions,
  builderAgentDefinition,
  criticAgentDefinition,
  exploreAgentDefinition,
  foremanAgentDefinition,
  librarianAgentDefinition,
  orchestratorAgentDefinition,
  productAgentDefinition,
  reviewerAgentDefinition,
  specAgentDefinition,
} from "./index";
import {
  TOOL_ASK_USER,
  TOOL_ARTIFACT_WRITE,
  TOOL_AST_GREP_REPLACE,
  TOOL_BASH,
  TOOL_FILE_EDIT,
  TOOL_FILE_WRITE,
  TOOL_WORKFLOW_PROPOSE_INTERACTIONS,
} from "../../tools/names";

const SOURCE_WRITE_TOOLS = [
  TOOL_FILE_WRITE,
  TOOL_FILE_EDIT,
  TOOL_BASH,
  TOOL_AST_GREP_REPLACE,
] as const;

function expectNoSourceWriteTools(tools: readonly string[]) {
  for (const tool of SOURCE_WRITE_TOOLS) {
    expect(tools).not.toContain(tool);
  }
}

describe("agentDefinitions", () => {
  test("names are unique", () => {
    const names = agentDefinitions.map((definition) => definition.name);

    expect(new Set(names).size).toBe(names.length);
  });

  test("orchestrator delegates to explore", () => {
    expect(orchestratorAgentDefinition.tools.delegateTargets).toContain("explore");
  });

  test("orchestrator includes workflow orchestration tools", () => {
    const tools = orchestratorAgentDefinition.tools.tools;

    expect(tools).toContain("workflow_create");
    expect(tools).toContain("workflow_read");
    expect(tools).toContain("workflow_update_stage");
    expect(tools).toContain("workflow_propose_interactions");
    expect(tools).toContain("workflow_request_interactions");
    expect(tools).toContain("artifact_read");
    expect(tools).not.toContain("artifact_write");
    expect(tools).toContain("workflow_task_check");
    expect(tools).toContain("ast_grep_search");
    expect(tools).toContain("ast_grep_replace");
  });

  test("workflow artifact author roles keep artifact_write", () => {
    expect(productAgentDefinition.tools.tools).toContain("artifact_write");
    expect(specAgentDefinition.tools.tools).toContain("artifact_write");
    expect(criticAgentDefinition.tools.tools).toContain("artifact_write");
  });

  test("workflow artifact author roles cannot mutate source code", () => {
    for (const definition of [productAgentDefinition, specAgentDefinition, criticAgentDefinition]) {
      expect(definition.tools.tools).toContain(TOOL_ARTIFACT_WRITE);
      expectNoSourceWriteTools(definition.tools.tools);
    }
  });

  test("Product, Spec, and Critic prompt structured required-interaction proposals instead of ask_user", () => {
    for (const definition of [productAgentDefinition, specAgentDefinition, criticAgentDefinition]) {
      expect(definition.tools.tools).toContain(TOOL_WORKFLOW_PROPOSE_INTERACTIONS);
      expect(definition.tools.tools).not.toContain(TOOL_ASK_USER);

      const prompt = definition.rolePrompt;
      expect(prompt).toContain("Required Interaction proposal contract");
      expect(prompt).toContain("workflow_propose_interactions");
      expect(prompt).toContain("decisionKey");
      expect(prompt).toContain("options");
      expect(prompt).toContain("at least 2 for decisions");
      expect(prompt).toContain("recommendedOption");
      expect(prompt).toContain("rationale");
      expect(prompt).not.toContain("blocking=true");
      expect(prompt).not.toContain("blocking=false");
      expect(prompt).toContain("After proposing interactions, you will be resumed with user answers");
      expect(prompt).toContain("Do NOT call ask_user directly");
    }
  });

  test("critic prompt limits user-decision proposals to high-value gates", () => {
    const prompt = criticAgentDefinition.rolePrompt;

    expect(prompt).toContain("product scope");
    expect(prompt).toContain("risk acceptance");
    expect(prompt).toContain("major tradeoffs");
    expect(prompt).toContain("unresolved ambiguity");
  });

  test("Foreman and Builder prompts default to autonomous coding after approval", () => {
    for (const definition of [foremanAgentDefinition, builderAgentDefinition]) {
      const prompt = definition.rolePrompt;

      expect(prompt).toContain("Autonomous-by-default coding after approval");
      expect(prompt).toContain("Ask the user ONLY for permissions/security confirmations");
      expect(prompt).toContain("true unrecoverable blockers");
      expect(prompt).toContain("plan-marked ask-before-changing decisions");
      expect(prompt).toContain("Do NOT ask about normal implementation choices");
    }
  });

  test("Explorer and Librarian prompts require concise evidence-driven research output", () => {
    for (const definition of [exploreAgentDefinition, librarianAgentDefinition]) {
      const prompt = definition.rolePrompt;

      expect(prompt).toContain("Research mandate");
      expect(prompt).toContain("When to research");
      expect(prompt).toContain("What to look for");
      expect(prompt).toContain("Concise evidence output");
      expect(prompt).toContain("Facts found");
      expect(prompt).toContain("Citations");
      expect(prompt).toContain("Unknowns");
    }
  });

  test("research role definitions cannot mutate source code", () => {
    for (const definition of [exploreAgentDefinition, librarianAgentDefinition]) {
      expectNoSourceWriteTools(definition.tools.tools);
    }
  });

  test("foreman includes Markdown-wave execution tools", () => {
    const tools = foremanAgentDefinition.tools.tools;

    expect(tools).toContain("artifact_read");
    expect(tools).toContain("workflow_task_check");
    expect(tools).toContain("todo_write");
    expect(tools).toContain("delegate");
    expect(tools).toContain("background_output");
    expect(tools).toContain("wait_for_reminder");
    expect(tools).toContain("view_tool_output");
    expect(tools).toContain("grep");
    expect(tools).toContain("glob");
    expect(tools).toContain("lsp_symbols");
    expect(tools).not.toContain("file_write");
    expect(tools).not.toContain("file_edit");
  });

  test("definitions do not expose target-side canBeDelegated", () => {
    for (const definition of agentDefinitions) {
      expect("canBeDelegated" in definition).toBe(false);
      expect("canBeDelegated" in definition.tools).toBe(false);
    }
  });

  test("orchestrator child policy matches current defaults", () => {
    expect(orchestratorAgentDefinition.childPolicy).toEqual({
      maxDepth: MAX_SUB_AGENT_DEPTH,
      maxConcurrent: MAX_CONCURRENT_SUB_AGENTS,
      timeoutMs: DEFAULT_SUB_AGENT_TIMEOUT_MS,
      abortCascade: true,
      terminalReminders: true,
    });
  });

  test("explore agent gets read-only tools plus todo_write (intentional exception)", () => {
    const exploreTools = exploreAgentDefinition.tools.tools;
    // Each EXPLORER_READ_ONLY_TOOL is available to the explorer
    for (const tool of EXPLORER_READ_ONLY_TOOLS) {
      expect(exploreTools).toContain(tool);
    }
    // todo_write is explicitly added — it's not readOnly but explorers need it
    // for the todo-continuation hook. This is the only intentional exception.
    const extraTools = exploreTools.filter(
      (t) => !(EXPLORER_READ_ONLY_TOOLS as readonly string[]).includes(t),
    );
    expect(extraTools).toEqual(["todo_write", "skill_list", "skill_read"]);
  });

  test("builder definition is the source-writing positive control", () => {
    for (const tool of SOURCE_WRITE_TOOLS) {
      expect(builderAgentDefinition.tools.tools).toContain(tool);
    }
  });

  test("explore agent cannot delegate", () => {
    expect("delegateTargets" in exploreAgentDefinition.tools).toBe(false);
    expect("childPolicy" in exploreAgentDefinition).toBe(false);
  });

  test("product, spec, critic, and reviewer can delegate to explore and librarian", () => {
    for (const definition of [
      productAgentDefinition,
      specAgentDefinition,
      criticAgentDefinition,
      reviewerAgentDefinition,
    ]) {
      expect(definition.tools.delegateTargets).toEqual(["explore", "librarian"]);
      expect(definition.childPolicy).toEqual({
        maxDepth: MAX_SUB_AGENT_DEPTH,
        maxConcurrent: MAX_CONCURRENT_SUB_AGENTS,
        timeoutMs: DEFAULT_SUB_AGENT_TIMEOUT_MS,
        abortCascade: true,
        terminalReminders: true,
      });
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
    test("all definitions have an explicit skills array", () => {
      for (const definition of agentDefinitions) {
        expect(definition).toHaveProperty("skills");
        expect(Array.isArray(definition.skills)).toBe(true);
      }
    });

    test("all skill names are valid", () => {
      for (const definition of agentDefinitions) {
        for (const skill of definition.skills) {
          expect(KNOWN_SKILLS).toContain(skill);
        }
      }
    });

    test("all agents with non-empty skills include skill_list and skill_read in tools", () => {
      for (const definition of agentDefinitions) {
        if (definition.skills.length > 0) {
          for (const skillTool of SKILL_TOOLS) {
            expect(definition.tools.tools).toContain(skillTool);
          }
        }
      }
    });

    test("allocation matrix matches exactly", () => {
      expect(orchestratorAgentDefinition.skills).toEqual([
        "git-master",
        "safe-refactor",
        "codemap",
        "review-work",
        "research-docs",
      ]);
      expect(exploreAgentDefinition.skills).toEqual([
        "codemap",
        "research-docs",
      ]);
      expect(productAgentDefinition.skills).toEqual(["research-docs"]);
      expect(specAgentDefinition.skills).toEqual([
        "codemap",
        "research-docs",
      ]);
      expect(criticAgentDefinition.skills).toEqual([
        "codemap",
        "review-work",
        "research-docs",
      ]);
      expect(foremanAgentDefinition.skills).toEqual([
        "codemap",
        "review-work",
      ]);
      expect(builderAgentDefinition.skills).toEqual([
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
      expect(librarianAgentDefinition.skills).toEqual([
        "codemap",
        "research-docs",
      ]);
    });
  });
});
