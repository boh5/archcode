import { describe, expect, test } from "bun:test";
import { buildRoleSection } from "./roles";
import type { PromptContext } from "../types";
import { agentDefinitions } from "../../agents/definitions";

function makeCtx(rolePrompt?: string): PromptContext {
  return {
    allowedTools: [],
    promptProfileId: "test",
    rolePrompt,
    env: {
      platform: "darwin",
      timezone: "America/Los_Angeles",
      locale: "en-US",
      projectRoot: "/workspace",
      cwd: "/workspace",
      versionControl: "git",
      date: "2026-05-18",
    },
  };
}

const REMOVED_GOAL_EXECUTABLE_TOOL_NAMES = [
  "goal_lock",
  "goal_run",
  "goal_retry",
  "goal_check_done",
] as const;

describe("buildRoleSection", () => {
  test("passes each current role delta through unchanged with one consistent heading", () => {
    for (const definition of agentDefinitions) {
      const result = buildRoleSection(makeCtx(definition.rolePrompt));

      expect(result).toBe(definition.rolePrompt);
      expect(result).toStartWith(`## Role: ${definition.displayName}`);
      expect(result).not.toContain("## Goal Role:");
      expect(result).not.toContain("## Workflow Role:");
    }
  });

  test("returns null when rolePrompt is absent", () => {
    expect(buildRoleSection(makeCtx(undefined))).toBeNull();
  });

  test("current role deltas omit removed Goal executable names", () => {
    for (const definition of agentDefinitions) {
      const result = buildRoleSection(makeCtx(definition.rolePrompt));
      for (const toolName of REMOVED_GOAL_EXECUTABLE_TOOL_NAMES) {
        expect(result).not.toContain(toolName);
      }
    }
  });
});
