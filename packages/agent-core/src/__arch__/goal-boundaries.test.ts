import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { agentDefinitions } from "../agents/definitions";
import { TOOL_CREATE_GOAL, TOOL_GET_GOAL, TOOL_UPDATE_GOAL } from "../tools/names";

const projectRoot = resolve(import.meta.dir, "../../../..");
const productionRoots = [
  "apps/server/src",
  "apps/web/src",
  "packages/agent-core/src",
  "packages/protocol/src",
] as const;

const removedPaths = [
  "packages/agent-core/src/goals/state.ts",
  "packages/agent-core/src/agents/definitions/goal-lead.ts",
  "packages/agent-core/src/skills/builtin/goal-create/SKILL.md",
  "packages/agent-core/src/tools/builtins/goal-create.ts",
  "packages/agent-core/src/tools/builtins/goal-manage.ts",
  "apps/server/src/routes/goals.ts",
  "apps/web/src/routes/goals.tsx",
  "apps/web/src/routes/goal-detail.tsx",
] as const;

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx)$/.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx")) out.push(path);
  }
  return out;
}

function productionMatches(pattern: RegExp): string[] {
  return productionRoots.flatMap((root) => sourceFiles(join(projectRoot, root)))
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(projectRoot, file));
}

describe("Session Goal hard-cut boundaries", () => {
  test("removed first-class Goal implementations stay deleted", () => {
    expect(removedPaths.filter((path) => existsSync(join(projectRoot, path)))).toEqual([]);
  });

  test("production code does not revive legacy Goal identity or lifecycle vocabulary", () => {
    expect(productionMatches(/\b(?:goal_lead|goalId|sessionRole|goal_create|goal_manage|GoalLifecycleService|GoalStateManager)\b/)).toEqual([]);
    expect(productionMatches(/\bHitlScope\s*=\s*[^;\n]*["']goal["']/)).toEqual([]);
    expect(productionMatches(/open sessions,\s*goals, or automations/)).toEqual([]);
  });

  test("exactly five general-purpose agents remain", () => {
    expect(agentDefinitions.map((definition) => definition.name)).toEqual([
      "lead", "analyst", "build", "explore", "librarian",
    ]);
  });

  test("Lead owns conversational Goal control and other agents cannot mutate it", () => {
    const lead = agentDefinitions.find((definition) => definition.name === "lead");
    if (lead === undefined) throw new Error("Missing Lead definition");
    expect(lead.tools.tools).toEqual(expect.arrayContaining([TOOL_CREATE_GOAL, TOOL_GET_GOAL, TOOL_UPDATE_GOAL]));
    for (const definition of agentDefinitions.filter((candidate) => candidate.name !== "lead")) {
      expect(definition.tools.tools).not.toContain(TOOL_CREATE_GOAL);
      expect(definition.tools.tools).not.toContain(TOOL_UPDATE_GOAL);
    }
  });

  test("Session Goal is implemented as a cohesive Session-owned module", () => {
    expect(existsSync(join(projectRoot, "packages/agent-core/src/session-goal/service.ts"))).toBe(true);
    expect(existsSync(join(projectRoot, "packages/agent-core/src/session-goal/schema.ts"))).toBe(true);
    expect(existsSync(join(projectRoot, "packages/protocol/src/session-goal.ts"))).toBe(true);
  });
});
