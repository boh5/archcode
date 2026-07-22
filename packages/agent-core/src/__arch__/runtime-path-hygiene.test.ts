import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const srcRoot = resolve(import.meta.dir, "..");

function listProductionTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (
        entry === "__test_tmp__"
        || entry === "__arch__"
        || entry === "node_modules"
        || entry === "dist"
      ) {
        continue;
      }
      files.push(...listProductionTsFiles(fullPath));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    files.push(fullPath);
  }
  return files;
}

const AUTHORITY = [
  "sessions",
  "memory",
  "todos",
  "automations",
  "hitl-queue\\.json",
  "permissions\\.json",
  "session-cwd-migrations",
] as const;

function findOldAuthorityJoins(source: string): string[] {
  const collapsed = source.replace(/\s+/g, " ");
  const hits: string[] = [];
  for (const segment of AUTHORITY) {
    const literal = new RegExp(
      `join\\([^)]*["']\\.archcode["']\\s*,\\s*["']${segment}["']`,
    );
    const constant = new RegExp(
      `join\\([^)]*PROJECT_STATE_DIR_NAME\\s*,\\s*["']${segment}["']`,
    );
    if (literal.test(collapsed)) hits.push(`literal:.archcode,${segment}`);
    if (constant.test(collapsed)) hits.push(`const:PROJECT_STATE_DIR_NAME,${segment}`);
  }
  return hits;
}

test("no mayWriteLeadPlan in production sources", () => {
  const hits: string[] = [];
  for (const file of listProductionTsFiles(srcRoot)) {
    const text = readFileSync(file, "utf8");
    if (text.includes("mayWriteLeadPlan")) {
      hits.push(relative(srcRoot, file));
    }
  }
  expect(hits, hits.join("\n")).toEqual([]);
});

test("no old authority path joins outside runtime/ in production sources", () => {
  const hits: string[] = [];
  for (const file of listProductionTsFiles(srcRoot)) {
    const found = findOldAuthorityJoins(readFileSync(file, "utf8"));
    for (const detail of found) {
      hits.push(`${relative(srcRoot, file)} ~ ${detail}`);
    }
  }
  expect(hits, hits.join("\n")).toEqual([]);
});
