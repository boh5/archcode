import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, relative, resolve } from "node:path";

import { archcodeConfigSchema } from "../config/schema";

const srcRoot = resolve(import.meta.dir, "..");
const packageRoot = resolve(srcRoot, "..");
const projectRoot = resolve(packageRoot, "../..");

type Violation = {
  file: string;
  pattern: string;
};

const loopProductionFiles = [
  ...findTsFiles(join(projectRoot, "packages/agent-core/src/loops")),
  ...findTsFiles(join(projectRoot, "apps/server/src/routes")).filter((file) => /(?:loops|dashboard)\.ts$/.test(file)),
  ...findTsFiles(join(projectRoot, "apps/web/src/api")),
  ...findTsFiles(join(projectRoot, "apps/web/src/routes")).filter((file) => /(?:loops|loop-detail|dashboard)\.tsx$/.test(file)),
  join(projectRoot, "apps/web/src/components/features/CreateLoopDialog.tsx"),
  join(projectRoot, "packages/protocol/src/types.ts"),
  join(projectRoot, "packages/protocol/src/reduce.ts"),
].filter((file) => existsSync(file));

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

function relativeFile(filePath: string): string {
  return normalize(relative(projectRoot, filePath));
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function findTextViolations(files: string[], patterns: RegExp[], allow: (file: string, source: string, pattern: RegExp) => boolean = () => false): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"));
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

function minimalConfig(): Record<string, unknown> {
  return {
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local",
        options: { baseURL: "http://localhost:8090/v1", apiKey: "test-key" },
        models: {
          "test-model": {
            name: "Test Model",
            limit: { context: 128000, output: 8192 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    agents: {
      orchestrator: { model: "local:test-model" },
      plan: { model: "local:test-model" },
      build: { model: "local:test-model" },
      reviewer: { model: "local:test-model" },
      explore: { model: "local:test-model" },
      librarian: { model: "local:test-model" },
    },
  };
}

describe("Loop MVP scope guardrails", () => {
  test("Loop schedule production surface supports only manual and interval, not cron or event triggers", () => {
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

  test("Loop MVP has no goalTemplateId, token or daily budget fields", () => {
    expectNoViolations(findTextViolations(loopProductionFiles, [
      /\bgoalTemplateId\b/,
      /\btokenBudget\b/,
      /\bdailyBudget\b/,
      /\btoken\s*\/\s*daily\s+budget\b/i,
    ], (file, source, pattern) => {
      if (file !== "packages/protocol/src/types.ts") return false;
      if (pattern.source !== "\\btokenBudget\\b") return false;
      const loopTypes = source.slice(source.indexOf("// ─── Loop Types ───"), source.indexOf("export interface CommandResult"));
      return !loopTypes.includes("tokenBudget");
    }));
  });

  test("Loop readiness score remains nullable state only with no calculation helper", () => {
    expectNoViolations(findTextViolations(loopProductionFiles, [
      /\breadinessScore\b/,
      /\bcalculateReadiness\b/,
      /\breadiness\s*[:=]\s*(?:Math\.|Number\(|\d)/,
    ], (file, source, pattern) => {
      if (pattern.source !== "\\breadinessScore\\b") return false;
      if (file === "packages/protocol/src/types.ts") return /readinessScore\?: null/.test(source);
      if (file === "packages/agent-core/src/loops/state.ts") return /readinessScore:\s*z\.null\(\)\.optional\(\)/.test(source);
      return false;
    }));
  });

  test("Loop runtime and API do not include worktree, PR, push, or branch orchestration", () => {
    const orchestrationFiles = loopProductionFiles.filter((file) => {
      const rel = relativeFile(file);
      return !rel.endsWith("presets.ts") && !rel.endsWith("CreateLoopDialog.tsx");
    });

    expectNoViolations(findTextViolations(orchestrationFiles, [
      /\bworktree\b/i,
      /\bgit\s+push\b/i,
      /\bpull\s+request\b/i,
      /\bcreate\s+PR\b/i,
      /\bbranch\s+orchestration\b/i,
    ]));
  });

  test(".archcode.json schema rejects loops configuration", () => {
    const result = archcodeConfigSchema.safeParse({
      ...minimalConfig(),
      loops: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(expect.objectContaining({ code: "unrecognized_keys", keys: ["loops"] }));
  });
});
