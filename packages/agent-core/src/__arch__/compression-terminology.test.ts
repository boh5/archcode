import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, relative, resolve } from "node:path";

const srcRoot = resolve(import.meta.dir, "..");
const packageRoot = resolve(srcRoot, "..");
const projectRoot = resolve(packageRoot, "../..");

interface Violation {
  readonly file: string;
  readonly detail: string;
}

const forbiddenTerminology = [
  "legacy fallback",
  "old fallback",
  "compact fallback",
  "fallback compact",
  "safety fallback",
] as const;

const productionHookAndCommandFiles = [
  "packages/agent-core/src/agents/query/hooks/auto-compact.ts",
  "packages/agent-core/src/agents/query/hooks/hybrid-compression.ts",
  "packages/agent-core/src/commands/compact.ts",
] as const;

const compatibilityReferenceFiles = [
  "packages/agent-core/src/compact/compact.ts",
  "packages/agent-core/src/compact/index.ts",
  "packages/agent-core/src/store/helpers.ts",
  "packages/agent-core/src/store/projection.ts",
  "packages/agent-core/src/store/types.ts",
  "packages/protocol/src/reduce.ts",
  "packages/protocol/src/types.ts",
] as const;

function findFiles(dir: string, predicate: (entry: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (entry === "dist" || entry === "__test_tmp__" || entry === "node_modules" || entry === ".git") continue;
      files.push(...findFiles(fullPath, predicate));
      continue;
    }
    if (stats.isFile() && predicate(entry)) files.push(fullPath);
  }
  return files.sort();
}

function relativeFile(filePath: string): string {
  return normalize(relative(projectRoot, filePath));
}

function readProjectFile(relativePath: string): string {
  return readFileSync(join(projectRoot, relativePath), "utf8");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function expectNoViolations(violations: readonly Violation[]): void {
  const message = violations.map(({ file, detail }) => `${file} -> ${detail}`).join("\n");
  expect(violations, message).toEqual([]);
}

describe("compression architecture terminology", () => {
  test("production hooks and commands do not call or import the retired compact runtime", () => {
    const violations: Violation[] = [];
    for (const file of productionHookAndCommandFiles) {
      const source = stripComments(readProjectFile(file));
      const checks = [
        { detail: "imports compact runtime module", pattern: /from\s+["'][^"']*compact\/compact["']/ },
        { detail: "calls compact()", pattern: /\bcompact\s*\(/ },
        { detail: "calls commitCompact()", pattern: /\bcommitCompact\s*\(/ },
        { detail: "references CompactResult", pattern: /\bCompactResult\b/ },
      ];
      for (const { detail, pattern } of checks) {
        if (pattern.test(source)) violations.push({ file, detail });
      }
    }

    expectNoViolations(violations);
  });

  test("bounded compatibility references remain categorized", () => {
    const missingFiles = compatibilityReferenceFiles.filter((file) => !existsSync(join(projectRoot, file)));
    expect(missingFiles).toEqual([]);

    const compatibilityText = compatibilityReferenceFiles.map(readProjectFile).join("\n");
    expect(compatibilityText).toContain("CompactionPart");
    expect(compatibilityText).toContain("compacted");
    expect(compatibilityText).toContain("<compact-summary>");
    expect(compatibilityText).toContain("tailStartId");
  });

  test("architecture prose avoids banned compression wording", () => {
    const docsAndSources = [
      ...findFiles(projectRoot, (entry) => /\.(md|ts|tsx)$/.test(entry)),
    ].filter((file) => {
      const relative = relativeFile(file);
      if (relative === "packages/agent-core/src/__arch__/compression-terminology.test.ts") return false;
      if (relative.startsWith(".sisyphus/")) return false;
      if (relative.startsWith("docs/plan/")) return false;
      return true;
    });
    const violations: Violation[] = [];

    for (const file of docsAndSources) {
      const source = readFileSync(file, "utf8").toLowerCase();
      for (const phrase of forbiddenTerminology) {
        if (source.includes(phrase)) violations.push({ file: relativeFile(file), detail: phrase });
      }
    }

    expectNoViolations(violations);
  });
});
