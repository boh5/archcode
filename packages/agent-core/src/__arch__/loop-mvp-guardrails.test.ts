import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, relative, resolve } from "node:path";

import { LOOP_PROFILE_ONLY_CONNECTOR_TOOLS } from "../loops/tool-profiles";

const srcRoot = resolve(import.meta.dir, "..");
const packageRoot = resolve(srcRoot, "..");
const projectRoot = resolve(packageRoot, "../..");
const loopSourceRoot = join(projectRoot, "packages/agent-core/src/loops");
const toolSourceRoot = join(projectRoot, "packages/agent-core/src/tools");
const integrationSourceRoot = join(projectRoot, "packages/agent-core/src/integrations");
const protocolTypesFile = join(projectRoot, "packages/protocol/src/types.ts");
const loopStateFile = join(loopSourceRoot, "state.ts");
const loopRunnerFile = join(loopSourceRoot, "runner.ts");
const loopSchedulerFile = join(loopSourceRoot, "scheduler.ts");

type Violation = {
  file: string;
  pattern: string;
};

const loopProductionFiles = [
  ...findTsFiles(loopSourceRoot),
  ...findTsFiles(join(projectRoot, "apps/server/src/routes")).filter((file) => /(?:loops|dashboard)\.ts$/.test(file)),
  ...findTsFiles(join(projectRoot, "apps/web/src/api")),
  ...findTsFiles(join(projectRoot, "apps/web/src/routes")).filter((file) => /(?:loops|loop-detail|dashboard)\.tsx$/.test(file)),
  join(projectRoot, "apps/web/src/components/features/CreateLoopDialog.tsx"),
  protocolTypesFile,
  join(projectRoot, "packages/protocol/src/reduce.ts"),
].filter((file) => existsSync(file));

const loopRuntimeFiles = findTsFiles(loopSourceRoot).filter((file) => !relativeFile(file).endsWith("presets.ts"));
const loopRunnerBoundaryFiles = [loopRunnerFile, loopSchedulerFile].filter((file) => existsSync(file));
const connectorDescriptorFiles = [
  ...findTsFiles(toolSourceRoot),
  ...findTsFiles(integrationSourceRoot),
];

function findTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (entry === "dist" || entry === "__tests__" || entry === "__test_tmp__") continue;
      files.push(...findTsFiles(fullPath));
      continue;
    }

    if (
      stats.isFile() &&
      /\.tsx?$/.test(entry) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx") &&
      !entry.endsWith("test-utils.ts")
    ) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function relativeFile(filePath: string): string {
  return normalize(relative(projectRoot, filePath));
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function readProductionSource(filePath: string): string {
  return stripComments(readFileSync(filePath, "utf8"));
}

function findTextViolations(files: string[], patterns: RegExp[], allow: (file: string, source: string, pattern: RegExp) => boolean = () => false): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const source = readProductionSource(file);
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(source) && !allow(relativeFile(file), source, pattern)) {
        violations.push({ file: relativeFile(file), pattern: pattern.source });
      }
    }
  }
  return violations;
}

function expectNoViolations(violations: Violation[]): void {
  const message = violations.map(({ file, pattern }) => `${file} -> ${pattern}`).join("\n");
  expect(violations, message).toEqual([]);
}

function sourceSection(filePath: string, start: string, end: string): string {
  const source = readProductionSource(filePath);
  const startIndex = source.indexOf(start);
  if (startIndex < 0) throw new Error(`Missing section start "${start}" in ${relativeFile(filePath)}`);
  const endIndex = source.indexOf(end, startIndex);
  if (endIndex < 0) throw new Error(`Missing section end "${end}" in ${relativeFile(filePath)}`);
  return source.slice(startIndex, endIndex);
}

function extractDefineToolObjectBlocks(source: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  const marker = "defineTool";

  while (cursor < source.length) {
    const callIndex = source.indexOf(marker, cursor);
    if (callIndex < 0) break;
    const openParen = source.indexOf("(", callIndex + marker.length);
    const openBrace = openParen < 0 ? -1 : source.indexOf("{", openParen);
    if (openParen < 0 || openBrace < 0) {
      cursor = callIndex + marker.length;
      continue;
    }

    let depth = 0;
    let quote: '"' | "'" | "`" | undefined;
    let escaped = false;
    for (let index = openBrace; index < source.length; index += 1) {
      const char = source[index];
      if (quote !== undefined) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = undefined;
        }
        continue;
      }

      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") depth += 1;
      if (char !== "}") continue;

      depth -= 1;
      if (depth === 0) {
        blocks.push(source.slice(openBrace, index + 1));
        cursor = index + 1;
        break;
      }
    }

    if (cursor <= callIndex) cursor = callIndex + marker.length;
  }

  return blocks;
}

function findConnectorMutatingToolDescriptorViolations(files: string[]): Violation[] {
  const violations: Violation[] = [];
  const connectorNamePattern = /name\s*:\s*(?:["'](?:github|github_actions|actions)_|LOOP_GITHUB_|LOOP_ACTIONS_)/i;
  const mutatingNamePattern = /CREATE|UPDATE|DELETE|RERUN|CANCEL|MERGE|APPROVE|LABEL|ASSIGN|CLOSE|REOPEN|PUSH|REBASE|create|update|delete|rerun|cancel|merge|approve|label|assign|close|reopen|push|rebase/;

  for (const file of files) {
    const source = readProductionSource(file);
    for (const block of extractDefineToolObjectBlocks(source)) {
      if (!connectorNamePattern.test(block) || !mutatingNamePattern.test(block)) continue;

      if (!/readOnly\s*:\s*false/.test(block)) {
        violations.push({ file: relativeFile(file), pattern: "mutating connector descriptor must set traits.readOnly false" });
      }
      if (!/permissions\s*:\s*\[(?!\s*\])/.test(block)) {
        violations.push({ file: relativeFile(file), pattern: "mutating connector descriptor must declare permissions/HITL coverage" });
      }
    }
  }

  return violations;
}

describe("Loop Phase 4 architecture guardrails", () => {
  test("Loop schedule production surface remains manual and interval only", () => {
    expectNoViolations(findTextViolations(loopProductionFiles, [
      /kind\s*:\s*["']cron["']/,
      /kind\s*:\s*["']event["']/,
      /z\.literal\(\s*["']cron["']\s*\)/,
      /z\.literal\(\s*["']event["']\s*\)/,
      /schedule\s*\.\s*kind\s*={?\s*["']cron["']/,
      /schedule\s*\.\s*kind\s*={?\s*["']event["']/,
      /on_(?:commit|pr|ci_fail)/,
    ]));
  });

  test("Loop Phase 4 surface keeps budget, PR collision, integration, and profile metadata first-class", () => {
    const loopStateSource = readProductionSource(loopStateFile);
    const protocolSource = readProductionSource(protocolTypesFile);

    expect(loopStateSource).toContain("export const LoopBudgetConfigSchema");
    expect(loopStateSource).toMatch(/budget:\s*LoopBudgetConfigSchema\.optional\(\)/);
    expect(loopStateSource).toMatch(/limits:\s*LoopLimitsSchema/);
    expect(loopStateSource).toMatch(/toolProfileId:\s*LoopToolProfileIdSchema\.optional\(\)/);
    expect(loopStateSource).toMatch(/collisionTargets:\s*z\.array\(CollisionTargetSchema\)/);
    expect(loopStateSource).toMatch(/type:\s*z\.literal\(["']pr["']\)/);
    expect(loopStateSource).toMatch(/integrationId:\s*z\.enum\(\[["']github["'],\s*["']github_actions["']\]\)/);
    expect(loopStateSource).toMatch(/latestBudget:\s*LoopBudgetSnapshotSchema\.optional\(\)/);
    expect(loopStateSource).toMatch(/latestIntegrations:\s*LoopIntegrationSnapshotSchema\.optional\(\)/);

    expect(protocolSource).toMatch(/budget\?:\s*LoopBudgetConfig/);
    expect(protocolSource).toMatch(/toolProfileId\?:\s*LoopToolProfileId/);
    expect(protocolSource).toMatch(/collisionTargets\?:\s*CollisionTarget\[\]/);
    expect(protocolSource).toMatch(/\{\s*type:\s*["']pr["'];\s*owner:\s*string;\s*repo:\s*string;\s*number:\s*number\s*\}/);
    expect(protocolSource).toMatch(/integrationErrors\?:\s*LoopIntegrationError\[\]/);
    expect(protocolSource).toMatch(/latestIntegrations\?:\s*LoopIntegrationSnapshot/);
  });

  test("Loop runtime has no readiness maturity gates beyond nullable compatibility state", () => {
    expectNoViolations(findTextViolations(loopProductionFiles, [
      /\bcalculateReadiness\b/,
      /\bpromoteLoop\b/,
      /\bgraduateLoop\b/,
      /\bgraduation\b/,
      /\bnoiseRate\b/,
      /\breadiness\s*[:=]\s*(?:Math\.|Number\(|\d)/,
      /\breadinessScore\b/,
    ], (file, source, pattern) => {
      if (pattern.source !== "\\breadinessScore\\b") return false;
      if (file === "packages/protocol/src/types.ts") return /readinessScore\?: null/.test(source);
      if (file === "packages/agent-core/src/loops/state.ts") return /readinessScore:\s*z\.null\(\)\.optional\(\)/.test(source);
      return false;
    }));
  });

  test("Loop runner and scheduler do not bypass connector or GitHub API tool boundaries", () => {
    expectNoViolations(findTextViolations(loopRunnerBoundaryFiles, [
      /from\s+["'][^"']*(?:integrations\/github|connectors\/github|github-actions|\/github)[^"']*["']/i,
      /import\s*\(\s*["'][^"']*(?:integrations\/github|connectors\/github|github-actions|\/github)[^"']*["']\s*\)/i,
      /https:\/\/api\.github\.com/,
      /fetch\s*\(\s*["'`]https:\/\/api\.github\.com/,
    ]));
  });

  test("Loop runner and scheduler do not directly orchestrate git push, merge, rebase, or worktrees", () => {
    expectNoViolations(findTextViolations(loopRunnerBoundaryFiles, [
      /\bworktree\b/i,
      /["'`]\s*git\s+(?:push|merge|rebase|worktree)\b/i,
      /["']git["']\s*,\s*["'](?:push|merge|rebase|worktree)["']/i,
    ]));
  });

  test("Loop config schema and protocol types do not accept raw per-loop tool arrays", () => {
    const stateConfigSchema = sourceSection(loopStateFile, "export const LoopConfigSchema", "export const LoopRunReportStatusSchema");
    const protocolLoopConfig = sourceSection(protocolTypesFile, "export interface LoopConfig", "export type LoopRunReportStatus");

    expect(stateConfigSchema).not.toMatch(/\btools\s*:/);
    expect(stateConfigSchema).not.toMatch(/\ballowedTools\s*:/);
    expect(stateConfigSchema).not.toMatch(/z\.array\(\s*z\.string\(\)/);
    expect(protocolLoopConfig).not.toMatch(/^\s*tools\??:\s*(?:readonly\s+)?string\[\]/m);
    expect(protocolLoopConfig).not.toMatch(/^\s*allowedTools\??:\s*(?:readonly\s+)?string\[\]/m);
  });

  test("future mutating connector tool descriptors must be effectful and permission-gated", () => {
    expect(LOOP_PROFILE_ONLY_CONNECTOR_TOOLS.length).toBeGreaterThan(0);
    expectNoViolations(findConnectorMutatingToolDescriptorViolations(connectorDescriptorFiles));
  });

  test("Phase 5a worktree and same-branch queue concepts stay out of Phase 4 Loop runtime", () => {
    expectNoViolations(findTextViolations(loopRuntimeFiles, [
      /\bworktree\b/i,
      /\bmaxConcurrent\b/,
      /same[-_\s]?branch/i,
      /\bsameBranchQueue\b/i,
    ]));
  });
});
