import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AnyToolDescriptor } from "../tools/types";
import type { AgentType } from "./agent-registry";
import { DELEGATION_TOOLS, EXPLORER_READ_ONLY_TOOLS } from "./explorer-agent";
import { getToolsForDepth } from "./tool-filter";

function makeTool(name: string): AnyToolDescriptor {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}).strict(),
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: () => `${name} result`,
  };
}

function toolNames(tools: AnyToolDescriptor[]): string[] {
  return tools.map((tool) => tool.name);
}

const unknownTool = makeTool("file_write");
const explorerReadOnlyTools = EXPLORER_READ_ONLY_TOOLS.map(makeTool);
const delegationTools = DELEGATION_TOOLS.map(makeTool);
const allTools = [unknownTool, ...explorerReadOnlyTools, ...delegationTools];

describe("getToolsForDepth", () => {
  test('depth 0 + "explore" returns read-only and delegation tools', () => {
    const tools = getToolsForDepth(0, "explore", allTools);

    expect(toolNames(tools)).toEqual([...EXPLORER_READ_ONLY_TOOLS, ...DELEGATION_TOOLS]);
  });

  test('depth 1 + "explore" returns read-only and delegation tools', () => {
    const tools = getToolsForDepth(1, "explore", allTools);

    expect(toolNames(tools)).toEqual([...EXPLORER_READ_ONLY_TOOLS, ...DELEGATION_TOOLS]);
  });

  test('depth 2 + "explore" returns read-only tools only', () => {
    const tools = getToolsForDepth(2, "explore", allTools);

    expect(toolNames(tools)).toEqual([...EXPLORER_READ_ONLY_TOOLS]);
    expect(toolNames(tools)).not.toContain("delegate");
    expect(toolNames(tools)).not.toContain("background_output");
    expect(toolNames(tools)).not.toContain("wait_for_reminder");
  });

  test("unknown agent type returns all tools without filtering", () => {
    const tools = getToolsForDepth(2, "oracle" as AgentType, allTools);

    expect(tools).toBe(allTools);
  });

  test("tools not in the allowed set are excluded for explore", () => {
    const tools = getToolsForDepth(0, "explore", [makeTool("grep"), unknownTool]);

    expect(toolNames(tools)).toEqual(["grep"]);
  });

  test("empty allTools array returns empty result", () => {
    expect(getToolsForDepth(0, "explore", [])).toEqual([]);
    expect(getToolsForDepth(2, "oracle" as AgentType, [])).toEqual([]);
  });
});
