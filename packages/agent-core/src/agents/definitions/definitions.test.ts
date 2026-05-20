import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  EXPLORER_READ_ONLY_TOOLS,
  MAX_CONCURRENT_SUB_AGENTS,
  MAX_SUB_AGENT_DEPTH,
} from "../constants";
import {
  agentDefinitions,
  exploreAgentDefinition,
  foremanAgentDefinition,
  orchestratorAgentDefinition,
} from "./index";

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
    expect(tools).toContain("artifact_read");
    expect(tools).toContain("artifact_write");
    expect(tools).toContain("workflow_task_check");
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
    expect(extraTools).toEqual(["todo_write"]);
  });

  test("explore agent cannot delegate", () => {
    expect("delegateTargets" in exploreAgentDefinition.tools).toBe(false);
    expect("childPolicy" in exploreAgentDefinition).toBe(false);
  });
});
