import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const srcRoot = join(import.meta.dir, "..");

function findTestFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__test_tmp__") files.push(...findTestFiles(path));
      continue;
    }
    if (entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

function relativeFile(path: string): string {
  return relative(srcRoot, path).replaceAll("\\", "/");
}

function hasUnsafeDefaultProcessRunner(source: string): boolean {
  const calls = [...source.matchAll(/\bcreateProcessRunner\s*\(\s*\)/g)];
  if (calls.length === 0) return false;

  const testStarts = [...source.matchAll(/^\s*test(?:\.[a-zA-Z]+)?\s*\(/gm)]
    .map((match) => match.index);
  const lifecycleSetup = source.slice(0, testStarts[0] ?? 0);
  const restoresAfterEach = /\bafterEach\s*\([\s\S]*?\bsetProcessRunnerForTest\s*\(\s*undefined\s*\)/
    .test(lifecycleSetup);
  if (!restoresAfterEach) return true;

  for (const call of calls) {
    const callIndex = call.index;
    let testStart: number | undefined;
    for (const index of testStarts) {
      if (index >= callIndex) break;
      testStart = index;
    }
    if (testStart === undefined) return true;
    const localPrefix = source.slice(testStart, callIndex);
    const installsFake = [...localPrefix.matchAll(/\bsetProcessRunnerForTest\s*\(\s*([^)]*)\)/g)]
      .some((match) => match[1]?.trim() !== "undefined");
    if (!installsFake) return true;
  }
  return false;
}

function findLegacyIntegrationNames(): string[] {
  return findTestFiles(srcRoot)
    .map(relativeFile)
    .filter((file) => file.endsWith("-integration.test.ts"));
}

function findUnitResourceViolations(): string[] {
  const violations: string[] = [];

  for (const file of findTestFiles(srcRoot)) {
    const relativePath = relativeFile(file);
    if (relativePath.startsWith("__arch__/") || relativePath.endsWith(".integration.test.ts")) continue;

    const source = readFileSync(file, "utf8");
    const resources = [
      ["direct Bun process", /\bBun\.spawn(?:Sync)?\s*\(/],
      ["FakeLspServer", /\bnew\s+FakeLspServer\s*\(/],
      ["StdioLspTransport", /\bnew\s+StdioLspTransport\s*\(/],
      ["real Git fixture", /\b(?:createGitRepo|initializeGitRepo|runGit)\s*\(/],
      ["default ProcessRunner", /\bcreateProcessRunner\s*\(\s*\)/],
      ["production source workspace", /\b(?:storeManager\.create|createSessionStore)\s*\([^\n]*\bimport\.meta\.dir\b/],
    ] as const;

    for (const [label, pattern] of resources) {
      if (label === "default ProcessRunner") {
        if (hasUnsafeDefaultProcessRunner(source)) violations.push(`${relativePath}: ${label}`);
        continue;
      }
      if (!pattern.test(source)) continue;
      violations.push(`${relativePath}: ${label}`);
    }
  }

  return violations;
}

describe("test lane boundaries", () => {
  test("uses only the canonical .integration.test.ts suffix", () => {
    expect(findLegacyIntegrationNames()).toEqual([]);
  });

  test("keeps real OS resources out of unit test files", () => {
    expect(findUnitResourceViolations()).toEqual([]);
  });

  test("does not let a ProcessRunner setter in one test authorize a later unmocked call", () => {
    expect(hasUnsafeDefaultProcessRunner(`
      afterEach(() => setProcessRunnerForTest(undefined));
      test("mocked", () => {
        setProcessRunnerForTest(fakeSpawn);
        createProcessRunner();
      });
      test("unmocked", () => {
        createProcessRunner();
      });
    `)).toBe(true);
  });

  test("allows a default ProcessRunner only when its own test installs and restores a fake", () => {
    expect(hasUnsafeDefaultProcessRunner(`
      afterEach(() => setProcessRunnerForTest(undefined));
      test("mocked", () => {
        setProcessRunnerForTest(fakeSpawn);
        createProcessRunner();
      });
    `)).toBe(false);
  });

  test("does not treat resetting the ProcessRunner as installing a fake", () => {
    expect(hasUnsafeDefaultProcessRunner(`
      afterEach(() => setProcessRunnerForTest(undefined));
      test("unmocked", () => {
        setProcessRunnerForTest(undefined);
        createProcessRunner();
      });
    `)).toBe(true);
  });
});
