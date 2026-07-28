import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../../../..");

function productionTsFiles(relativeDir: string): string[] {
  const root = join(projectRoot, relativeDir);
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === "dist" || entry === "__test_tmp__" || entry === "__arch__") continue;
      files.push(...productionTsFiles(relative(projectRoot, path)));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      files.push(path);
    }
  }
  return files.sort();
}

function source(relativePath: string): string {
  return readFileSync(join(projectRoot, relativePath), "utf8");
}

function productionMatches(patterns: readonly RegExp[]): string[] {
  const roots = ["packages/agent-core/src", "packages/protocol/src", "apps/server/src", "apps/web/src"];
  const matches: string[] = [];
  for (const file of roots.flatMap(productionTsFiles)) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) matches.push(`${relative(projectRoot, file)} -> ${pattern.source}`);
    }
  }
  return matches;
}

describe("HITL architecture", () => {
  test("HITL Core is independent of Session, Goal, tools, and project orchestration", () => {
    const files = productionTsFiles("packages/agent-core/src/hitl");
    const violations = files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const forbidden = /from\s+["']\.\.\/(?:agents|execution|session-goal|store|tools)\//.test(text)
        || /from\s+["']\.\.\/projects\/(?!runtime-path)/.test(text);
      return forbidden ? [relative(projectRoot, file)] : [];
    });
    expect(violations).toEqual([]);
  });

  test("tool batch scheduler owns no HITL persistence or Goal dependency", () => {
    const text = source("packages/agent-core/src/execution/session-tool-batch-scheduler.ts");
    expect(text).not.toMatch(/from\s+["'][^"']*session-goal\//);
    expect(text).not.toMatch(/from\s+["'][^"']*projects\//);
    expect(text).not.toMatch(/hitl-queue\.json|Bun\.file|atomicWrite/);
    expect(text).toContain("interface SessionToolBatchQueue");
  });

  test("Session persistence reuses the HITL-owned blocker schema", () => {
    const storeHelpers = source("packages/agent-core/src/store/helpers.ts");
    expect(storeHelpers).toContain("HitlBoundaryCodec.sessionToolCallBlockerSchema");
  });

  test("Runtime dispatch has a single Session HITL owner", () => {
    const text = source("packages/agent-core/src/runtime.ts");
    expect(text).toContain("sessionId: dispatching.owner.id");
  });

  test("Runtime HITL delivery logs use only redacted stable failures", () => {
    const runtime = source("packages/agent-core/src/runtime.ts");
    for (const event of ["hitl.delivery.failed"]) {
      const eventIndex = runtime.indexOf(`runtimeLogger.warn("${event}"`);
      expect(eventIndex).toBeGreaterThan(0);
      const snippet = runtime.slice(Math.max(0, eventIndex - 600), eventIndex + 500);
      expect(snippet).toContain("hitlCodec.redactFailure(error)");
      expect(snippet).toContain("redactionPolicy.redactValue(");
      expect(snippet).not.toMatch(/\berror\s*,/);
      expect(snippet).not.toContain("error.stack");
    }
  });
});
