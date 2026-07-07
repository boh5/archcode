import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, relative, resolve } from "node:path";

const srcRoot = resolve(import.meta.dir, "..");
const packageRoot = resolve(srcRoot, "..");
const projectRoot = resolve(packageRoot, "../..");

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

function findTextViolations(scopeDirs: readonly string[], patterns: readonly RegExp[]): Violation[] {
  const violations: Violation[] = [];
  for (const scopeDir of scopeDirs) {
    for (const file of findTsFiles(join(projectRoot, scopeDir))) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        if (pattern.test(source)) {
          violations.push({ file: normalize(relative(projectRoot, file)), pattern: pattern.source });
        }
      }
    }
  }
  return violations;
}

function expectNoViolations(violations: readonly Violation[]): void {
  const message = violations.map((violation) => `${violation.file} -> ${violation.pattern}`).join("\n");
  expect(violations, message).toEqual([]);
}

describe("unified HITL legacy boundary", () => {
  test("agent-core does not compile old deferred services or project-wide queue files", () => {
    const forbiddenPaths = [
      "packages/agent-core/src/deferred",
      "packages/agent-core/src/hitl/durable-queue.ts",
    ];

    expect(forbiddenPaths.filter((path) => existsSync(join(projectRoot, path)))).toEqual([]);
  });

  test("production backend code has no legacy deferred, queue, or pending-interaction references", () => {
    expectNoViolations(findTextViolations([
      "packages/agent-core/src",
      "apps/server/src",
      "packages/protocol/src",
    ], [
      /DeferredQuestionService\b/,
      /DeferredPermissionService\b/,
      /AskUserService\b/,
      /\bPermissionService\b/,
      /DurableHitlQueue\b/,
      /hitlQueuePath\b/,
      /hitl-queue\.json/,
      /pendingInteractions\b/,
      /PermissionRequestEvent\b/,
      /PermissionTerminalEvent\b/,
      /QuestionRequestEvent\b/,
      /QuestionTerminalEvent\b/,
      /"permission\.request"/,
      /"permission\.terminal"/,
      /"question\.request"/,
      /"question\.terminal"/,
      /\/api\/questions\b/,
      /\/api\/permissions\b/,
      /\/api\/hitl\//,
    ]));
  });

  test("production session storage exposes only owner-local session files", () => {
    expectNoViolations(findTextViolations(["packages/agent-core/src/store"], [
      /\.archcode\/sessions\/\$\{[^}]+\}\.json/,
      /getLegacySessionPath\b/,
      /getRootSessionPath\b/,
      /legacySessionPath\b/,
    ]));
  });
});
