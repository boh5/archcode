import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../../../..");

describe("Agent permission architecture", () => {
  test("keeps Agent-level permission tables in definitions", () => {
    const constants = readFileSync(join(projectRoot, "packages/agent-core/src/agents/constants.ts"), "utf8");
    expect(constants).toContain("SKILL_ACCESS_TOOLS");
    expect(constants).toContain("DELEGATION_CONTROL_TOOLS");

    for (const name of ["lead", "discussion", "analyst", "build", "explore", "librarian"]) {
      const source = readFileSync(join(projectRoot, `packages/agent-core/src/agents/definitions/${name}.ts`), "utf8");
      expect(source).toContain("tools: {");
      expect(source).toContain("authorized: [");
      expect(source).toContain("core: [");
    }

    for (const name of ["lead", "discussion", "analyst", "build"]) {
      const source = readFileSync(join(projectRoot, `packages/agent-core/src/agents/definitions/${name}.ts`), "utf8");
      expect(source).toContain("...DELEGATION_CONTROL_TOOLS");
    }
  });
});
