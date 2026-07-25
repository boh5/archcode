import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const srcRoot = resolve(import.meta.dir, "..");
const packageRoot = resolve(srcRoot, "..");
const projectRoot = resolve(packageRoot, "../..");

interface Violation {
  readonly file: string;
  readonly detail: string;
}

const hardCompactContractFiles = [
  "packages/agent-core/src/compact/compact.ts",
  "packages/agent-core/src/compact/index.ts",
  "packages/agent-core/src/store/helpers.ts",
  "packages/agent-core/src/store/projection.ts",
  "packages/agent-core/src/store/types.ts",
  "packages/protocol/src/reduce.ts",
  "packages/protocol/src/types.ts",
] as const;

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
});
