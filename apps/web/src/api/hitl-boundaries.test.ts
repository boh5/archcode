import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, relative, resolve } from "node:path";

const webSrcRoot = resolve(import.meta.dir, "..");
const webRoot = resolve(webSrcRoot, "..");

interface Violation {
  readonly file: string;
  readonly pattern: string;
}

function findTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (entry === "dist" || entry === "__test_tmp__") continue;
      files.push(...findTsFiles(fullPath));
      continue;
    }
    if (stats.isFile() && /\.tsx?$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function findTextViolations(patterns: readonly RegExp[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of findTsFiles(webSrcRoot)) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(source)) violations.push({ file: normalize(relative(webRoot, file)), pattern: pattern.source });
    }
  }
  return violations;
}

function expectNoViolations(violations: readonly Violation[]): void {
  const message = violations.map((violation) => `${violation.file} -> ${violation.pattern}`).join("\n");
  expect(violations, message).toEqual([]);
}

describe("web HITL legacy boundary", () => {
  test("production Web code uses canonical scoped HITL only", () => {
    expectNoViolations(findTextViolations([
      /pendingPermissions\b/,
      /pendingQuestions\b/,
      /AttentionQueue\b/,
      /useAttentionQueue\b/,
      /use-attention-queue/,
      /\/api\/questions\b/,
      /\/api\/permissions\b/,
      /\/api\/hitl\//,
      /Human Attention/,
      /PermissionRequest\b/,
      /QuestionRequest\b/,
      /QuestionAnswerBody\b/,
      /PermissionRequestEvent\b/,
      /PermissionTerminalEvent\b/,
      /QuestionRequestEvent\b/,
      /QuestionTerminalEvent\b/,
      /"permission\.request"/,
      /"permission\.terminal"/,
      /"question\.request"/,
      /"question\.terminal"/,
      /dashboardHitlItemToProjection\b/,
      /dashboardHitlItemToSource\b/,
      /dashboardHitlAllowedActions\b/,
      /DashboardHitlItem\b/,
      /DashboardHitlKind\b/,
      /DashboardHitlTrigger\b/,
    ]));
  });
});
