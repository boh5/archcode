import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { agentDefinitions } from "../agents/definitions";
import { TOOL_CREATE_GOAL, TOOL_GET_GOAL, TOOL_UPDATE_GOAL } from "../tools/names";

const projectRoot = resolve(import.meta.dir, "../../../..");
describe("Session Goal boundaries", () => {
  test("defines exactly five general-purpose agents", () => {
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
