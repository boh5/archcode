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

describe("HITL hard-cut architecture", () => {
  test("legacy owner-local and dedicated resume modules stay deleted", () => {
    const removed = [
      "packages/agent-core/src/hitl/owner-store.ts",
      "packages/agent-core/src/hitl/owner-paths.ts",
      "packages/agent-core/src/hitl/aggregation.ts",
      "packages/agent-core/src/hitl/resume-coordinator.ts",
      "packages/agent-core/src/hitl/service.ts",
      "packages/agent-core/src/hitl/goal-gates.ts",
      "packages/agent-core/src/goals/hitl-resume-adapter.ts",
      "packages/agent-core/src/execution/session-hitl-journal-store.ts",
      "packages/agent-core/src/execution/session-hitl-resume-adapter.ts",
      "packages/agent-core/src/execution/session-hitl-pause.ts",
    ];
    expect(removed.filter((path) => existsSync(join(projectRoot, path)))).toEqual([]);
    expect(productionTsFiles("packages/agent-core/src/execution")
      .map((path) => relative(projectRoot, path))
      .filter((path) => /session-hitl-/.test(path))).toEqual([]);
  });

  test("HITL Core is independent of Session, Goal, tools, and project orchestration", () => {
    const files = productionTsFiles("packages/agent-core/src/hitl");
    const violations = files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return /from\s+["']\.\.\/(?:agents|execution|goals|projects|store|tools)\//.test(text)
        ? [relative(projectRoot, file)]
        : [];
    });
    expect(violations).toEqual([]);
  });

  test("tool batch scheduler owns no HITL persistence or Goal dependency", () => {
    const text = source("packages/agent-core/src/execution/session-tool-batch-scheduler.ts");
    expect(text).not.toMatch(/from\s+["'][^"']*goals\//);
    expect(text).not.toMatch(/from\s+["'][^"']*projects\//);
    expect(text).not.toMatch(/hitl-queue\.json|Bun\.file|atomicWrite/);
    expect(text).toContain("interface SessionToolBatchQueue");
  });

  test("Session persistence reuses the HITL-owned blocker schema without a local copy", () => {
    const storeHelpers = source("packages/agent-core/src/store/helpers.ts");
    expect(storeHelpers).toContain("HitlBoundaryCodec.sessionToolCallBlockerSchema");
    expect(storeHelpers).not.toMatch(/SessionToolBatchHitlSourceSchema|HitlDisplayPayloadSchema|SessionToolBatchHitlResponseSchema/);
    expect(storeHelpers).not.toMatch(/const\s+SessionToolCallBlockerSchema/);
  });

  test("Goal budget handler owns no tool, Session, or LLM execution", () => {
    const text = source("packages/agent-core/src/goals/budget-handler.ts");
    expect(text).not.toMatch(/from\s+["'][^"']*(?:agents\/query|execution|store|tools)\//);
    expect(text).not.toMatch(/runLlm|ToolRegistry|SessionExecution/);
  });

  test("Runtime dispatch remains an explicit two-owner switch", () => {
    const text = source("packages/agent-core/src/runtime.ts");
    expect(text).toContain("switch (dispatching.owner.type)");
    expect(text).toContain('case "session"');
    expect(text).toContain('case "goal"');
    expect(text).not.toMatch(/hitlHandlerRegistry|registerHitlHandler|hitlHandlers\s*=\s*new Map/);
  });

  test("production contains no retired HITL compatibility vocabulary", () => {
    expect(productionMatches([
      /\bHitlOwnerStore\b/,
      /\bresolveHitlOwnerPath\b/,
      /\baggregateHitlProjections\b/,
      /\bSessionHitlBlocker\b/,
      /\bblockedHitl\b/,
      /\bSessionHitlPause\b/,
      /\bSessionHitlResumeAdapter\b/,
      /\bSessionHitlResumeLease\b/,
      /\bResumeCoordinator\b/,
      /\bGoalGateService\b/,
      /\bGoalHitlResumeAdapter\b/,
      /hitl-journal\.json/,
      /\bdurableHitlMode\b/,
      /\bgoal_question\b/,
      /\bgoal_approval\b/,
      /\bgoal_review\b/,
      /\bprojectionPath\b/,
    ])).toEqual([]);
  });

  test("retired callback HITL contracts and public exports stay deleted", () => {
    expect(productionMatches([
      /\bToolConfirmationRequest\b/,
      /\bToolConfirmationResult\b/,
      /\bToolConfirmationCallback\b/,
      /\bAskUserRequest\b/,
      /\bAskUserAnswer\b/,
      /\bAskUserCallback\b/,
      /\bconfirmPermission\s*\??:/,
      /\baskUser\s*\??:/,
    ])).toEqual([]);

    for (const relativePath of [
      "packages/agent-core/src/tools/index.ts",
      "packages/agent-core/src/index.ts",
    ]) {
      expect(source(relativePath)).not.toMatch(/\b(?:ToolConfirmation(?:Request|Result|Callback)|AskUser(?:Request|Answer|Callback))\b/);
    }
  });

  test("Runtime HITL delivery logs use only redacted stable failures", () => {
    const runtime = source("packages/agent-core/src/runtime.ts");
    for (const event of ["session.tool_batch.wake_failed", "hitl.delivery.failed"]) {
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
