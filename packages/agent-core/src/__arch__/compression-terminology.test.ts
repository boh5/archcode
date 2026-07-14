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

const hardCompactContractFiles = [
  "packages/agent-core/src/compact/compact.ts",
  "packages/agent-core/src/compact/index.ts",
  "packages/agent-core/src/store/helpers.ts",
  "packages/agent-core/src/store/projection.ts",
  "packages/agent-core/src/store/types.ts",
  "packages/protocol/src/reduce.ts",
  "packages/protocol/src/types.ts",
] as const;

const architectureProseRoots = [
  "apps",
  "packages",
  "scripts",
  "design",
  "docs",
] as const;

const architectureProseRootFiles = [
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
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
  test("production hard-threshold hooks and commands use the forced compact runtime", () => {
    const violations: Violation[] = [];
    const hardThresholdFiles = [
      "packages/agent-core/src/agents/query/hooks/hybrid-compression.ts",
      "packages/agent-core/src/commands/compact.ts",
    ] as const;

    for (const file of hardThresholdFiles) {
      const source = stripComments(readProjectFile(file));
      const checks = [
        { detail: "does not call compact()", pattern: /\bcompact\s*\(/ },
        { detail: "does not call commitCompact()", pattern: /\bcommitCompact\s*\(/ },
      ];
      for (const { detail, pattern } of checks) {
        if (!pattern.test(source)) violations.push({ file, detail });
      }
    }

    const allProductionText = productionHookAndCommandFiles.map((file) => stripComments(readProjectFile(file))).join("\n");
    const forbiddenSystemPathChecks = [
      { detail: "imports prepareHardLimitCompression", pattern: /\bprepareHardLimitCompression\b/ },
      { detail: "imports prepareEmergencyCompression", pattern: /\bprepareEmergencyCompression\b/ },
      { detail: "branches on EMERGENCY_COMPACT_RATIO", pattern: /\bEMERGENCY_COMPACT_RATIO\b/ },
    ];
    for (const { detail, pattern } of forbiddenSystemPathChecks) {
      if (pattern.test(allProductionText)) violations.push({ file: "production compression hooks/commands", detail });
    }

    expectNoViolations(violations);
  });

  test("forced compact representation remains internally consistent", () => {
    const missingFiles = hardCompactContractFiles.filter((file) => !existsSync(join(projectRoot, file)));
    expect(missingFiles).toEqual([]);

    const contractText = hardCompactContractFiles.map(readProjectFile).join("\n");
    expect(contractText).toContain("CompactionPart");
    expect(contractText).toContain("compacted");
    expect(contractText).toContain("<compact-summary>");
    expect(contractText).toContain("tailStartId");
  });

  test("architecture prose avoids banned compression wording", () => {
    const docsAndSources = [
      ...architectureProseRootFiles.map((file) => join(projectRoot, file)),
      ...architectureProseRoots.flatMap((root) => (
        findFiles(join(projectRoot, root), (entry) => /\.(md|ts|tsx)$/.test(entry))
      )),
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
