import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../../../..");

function productionFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry.startsWith(".") || entry === "dist" || entry === "node_modules" || entry === "__test_tmp__") continue;
      files.push(...productionFiles(path));
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
      files.push(path);
    }
  }
  return files;
}

describe("shared-code hard-cut architecture", () => {
  test("removes legacy Agent tool groups and compatibility exports", () => {
    expect(existsSync(join(projectRoot, "packages/agent-core/src/tools/groups.ts"))).toBe(false);
    const forbidden = /\b(EXPLORER_READ_ONLY_TOOLS|DELEGATION_EXECUTION_TOOLS|DELEGATION_TOOLS|SKILL_TOOLS)\b/;
    const offenders = productionFiles(join(projectRoot, "packages/agent-core/src"))
      .filter((file) => forbidden.test(readFileSync(file, "utf8")))
      .map((file) => relative(projectRoot, file));
    expect(offenders).toEqual([]);
  });

  test("keeps Agent-level permission tables in definitions", () => {
    const constants = readFileSync(join(projectRoot, "packages/agent-core/src/agents/constants.ts"), "utf8");
    expect(constants).toContain("SKILL_ACCESS_TOOLS");
    expect(constants).toContain("DELEGATION_CORE_TOOLS");
    expect(constants).not.toMatch(/\b(ENGINEER_TOOLS|BASE_AGENT_TOOLS|READ_ONLY_AGENT_TOOLS)\b/);

    for (const name of ["lead", "analyst", "build", "analyst", "explore", "librarian", "lead"]) {
      const source = readFileSync(join(projectRoot, `packages/agent-core/src/agents/definitions/${name}.ts`), "utf8");
      expect(source).toContain("tools: [");
    }

    for (const name of ["lead", "analyst", "build", "analyst"]) {
      const source = readFileSync(join(projectRoot, `packages/agent-core/src/agents/definitions/${name}.ts`), "utf8");
      expect(source).toContain("...DELEGATION_CORE_TOOLS");
    }
  });
});
