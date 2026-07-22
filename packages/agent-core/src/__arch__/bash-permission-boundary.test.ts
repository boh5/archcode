import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../../../..");
const agentCoreRoot = join(projectRoot, "packages/agent-core/src");
const bashSecurityRoot = join(agentCoreRoot, "tools/security/bash");

function productionFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || ["__test_tmp__", "dist", "node_modules"].includes(entry.name)) return [];
      return productionFiles(join(root, entry.name));
    }
    const file = join(root, entry.name);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx") ? [file] : [];
  });
}

describe("Bash permission hard-cut architecture", () => {
  test("removes the legacy classifier, effects, policy, and scopes modules", () => {
    const removed = [
      "tools/security/bash-classifier.ts",
      "tools/security/bash/effects.ts",
      "tools/security/bash/parse.ts",
      "tools/security/bash/policy.ts",
      "tools/security/bash/scopes.ts",
    ].map((path) => join(agentCoreRoot, path));

    expect(removed.filter(existsSync).map((path) => relative(projectRoot, path))).toEqual([]);
  });

  test("keeps analysis independent from permission and HITL policy", () => {
    const violations = productionFiles(bashSecurityRoot)
      .filter((file) => /from\s+["'][^"']*(?:permission|hitl)/.test(readFileSync(file, "utf8")))
      .map((file) => relative(projectRoot, file));

    expect(violations).toEqual([]);
  });

  test("has one Bash decision owner and one analysis consumer", () => {
    const production = productionFiles(agentCoreRoot);
    const consumers = production
      .filter((file) => file !== join(bashSecurityRoot, "analyze.ts"))
      .filter((file) => /import[\s\S]*?\banalyzeBash\b[\s\S]*?from\s+["']/.test(readFileSync(file, "utf8")))
      .map((file) => relative(projectRoot, file));

    expect(consumers).toEqual(["packages/agent-core/src/tools/permission/bash.ts"]);

    const permission = readFileSync(join(agentCoreRoot, "tools/permission/bash.ts"), "utf8");
    expect(permission.match(/\banalyzeBash\s*\(/g)).toHaveLength(1);
    const analyzer = readFileSync(join(bashSecurityRoot, "analyze.ts"), "utf8");
    expect(analyzer).toContain("const nested = analyzeBashInternal(");

    const builtin = readFileSync(join(agentCoreRoot, "tools/builtins/bash.ts"), "utf8");
    expect(builtin).toContain("permissions: [createBashPermission()]");
    expect(builtin).not.toContain("createProtectedPathPermission");
  });

  test("keeps protected-path permission free of Bash parsing", () => {
    const protectedPath = readFileSync(join(agentCoreRoot, "tools/permission/protected-path.ts"), "utf8");
    expect(protectedPath).not.toMatch(/\banalyzeBash\b|bash-classifier|security\/bash/);
  });

  test("has one production owner for sensitive and protected path facts", () => {
    const production = productionFiles(join(agentCoreRoot, "tools"));
    const sensitiveOwners = production
      .filter((file) => /export function classifySensitivePath\s*\(/.test(readFileSync(file, "utf8")))
      .map((file) => relative(projectRoot, file));
    const protectedOwners = production
      .filter((file) => /export function isProtectedCanonicalMutationPath\s*\(/.test(readFileSync(file, "utf8")))
      .map((file) => relative(projectRoot, file));

    expect(sensitiveOwners).toEqual(["packages/agent-core/src/tools/permission/sensitive-file.ts"]);
    expect(protectedOwners).toEqual(["packages/agent-core/src/tools/permission/protected-path.ts"]);
  });

  test("keeps legacy Bash schema names only in the strict rejection boundary", () => {
    const production = productionFiles(join(agentCoreRoot, "tools"));
    const forbidden = /\bShellEffect\b|\battachShellEffects\b|bash-classifier|security\/bash\/(?:effects|policy|scopes)|\bnormalized\s*:/;
    const symbolViolations = production
      .filter((file) => forbidden.test(readFileSync(file, "utf8")))
      .map((file) => relative(projectRoot, file));
    expect(symbolViolations).toEqual([]);

    const legacyLiteralOwners = production
      .filter((file) => readFileSync(file, "utf8").includes("bash-command"))
      .map((file) => relative(projectRoot, file));
    expect(legacyLiteralOwners).toEqual(["packages/agent-core/src/tools/permission/project-approvals.ts"]);
  });
});
