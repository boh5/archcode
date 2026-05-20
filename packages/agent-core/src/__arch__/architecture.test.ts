import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const srcRoot = resolve(import.meta.dir, "..");
const packageRoot = resolve(srcRoot, "..");
const projectRoot = resolve(packageRoot, "../..");

interface ImportRecord {
  file: string;
  importPath: string;
  isTypeOnly: boolean;
  resolvedPath?: string;
}

interface Violation {
  file: string;
  importPath: string;
}

function findTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
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

function extractImports(filePath: string): ImportRecord[] {
  const source = readFileSync(filePath, "utf8");
  const imports: ImportRecord[] = [];
  const importRegex = /import\s+(type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;

  for (const match of source.matchAll(importRegex)) {
    const importPath = match[2];
    if (!importPath) continue;

    imports.push({
      file: filePath,
      importPath,
      isTypeOnly: match[1] !== undefined || /^import\s*\{\s*type\b/.test(match[0]),
      resolvedPath: resolveImportPath(filePath, importPath),
    });
  }

  return imports;
}

function resolveImportPath(filePath: string, importPath: string): string | undefined {
  if (importPath.startsWith(".")) return normalize(relative(projectRoot, resolve(dirname(filePath), importPath)));
  if (importPath.startsWith("@specra/protocol")) return "packages/protocol/src";
  if (importPath.startsWith("@specra/agent-core")) return "packages/agent-core/src";
  if (importPath.startsWith("@specra/server")) return "apps/server/src";
  if (importPath.startsWith("@specra/web")) return "apps/web/src";
  return undefined;
}

function findViolations(scopeDir: string, forbiddenPatterns: RegExp[], allowedExceptions: RegExp[] = []): Violation[] {
  const scopePath = join(projectRoot, scopeDir);
  const violations: Violation[] = [];

  for (const file of findTsFiles(scopePath)) {
    for (const importRecord of extractImports(file)) {
      const candidates = [importRecord.importPath, importRecord.resolvedPath].filter(
        (candidate): candidate is string => candidate !== undefined,
      );
      const isAllowed = candidates.some((candidate) => allowedExceptions.some((pattern) => pattern.test(candidate)));
      const isForbidden = candidates.some((candidate) => forbiddenPatterns.some((pattern) => pattern.test(candidate)));

      if (isForbidden && !isAllowed) {
        violations.push(formatViolation(importRecord));
      }
    }
  }

  return violations;
}

function formatViolation(importRecord: ImportRecord): Violation {
  return {
    file: normalize(relative(projectRoot, importRecord.file)),
    importPath: importRecord.importPath,
  };
}

function expectNoViolations(violations: Violation[]): void {
  const message = violations.map(({ file, importPath }) => `${file} -> ${importPath}`).join("\n");
  expect(violations, message).toEqual([]);
}

describe("monorepo package boundaries", () => {
  test("protocol has no runtime dependencies", () => {
    expectNoViolations(
      findViolations("packages/protocol/src", [
        /^ai$/,
        /^zustand(\/|$)/,
        /^hono(\/|$)/,
        /^node:/,
        /^bun:/,
        /^react(\/|$)/,
        /^react-dom(\/|$)/,
        /^apps\//,
        /^@specra\/(agent-core|server|web)(\/|$)/,
        /^packages\/(agent-core|server|web)(\/|$)/,
        /^packages\/(agent-core|server|web)\/src(\/|$)/,
      ]),
    );
  });

  test("agent-core has no server/web dependencies", () => {
    expectNoViolations(
      findViolations("packages/agent-core/src", [
        /^hono(\/|$)/,
        /^apps\//,
        /^react(\/|$)/,
        /^react-dom(\/|$)/,
        /^@specra\/(server|web)(\/|$)/,
        /^packages\/(server|web)(\/|$)/,
        /^packages\/(server|web)\/src(\/|$)/,
      ]),
    );
  });

  test("server has no web/react dependencies", () => {
    expectNoViolations(
      findViolations("apps/server/src", [
        /^@specra\/web(\/|$)/,
        /^react(\/|$)/,
        /^react-dom(\/|$)/,
        /^apps\/web(\/|$)/,
        /^packages\/[^/]+\/src(\/|$)/,
      ], [/^@specra\/(protocol|agent-core)(\/|$)/, /^apps\/web\/dist(\/|$)/]),
    );
  });

  test("web has no runtime/server dependencies", () => {
    expectNoViolations(
      findViolations("apps/web/src", [
        /^@specra\/(agent-core|server)(\/|$)/,
        /^node:/,
        /^bun:/,
        /^apps\/server(\/|$)/,
        /^packages\/agent-core\/src(\/|$)/,
        /^packages\/server\/src(\/|$)/,
      ]),
    );
  });

  test("reduce isomorphism", () => {
    const reducePath = join(srcRoot, "store/reduce.ts");
    const imports = extractImports(reducePath).filter(({ importPath }) => importPath.startsWith("node:"));
    const bunApiMatches = readFileSync(reducePath, "utf8").match(/\bBun\./g) ?? [];
    const violations = [
      ...imports.map(formatViolation),
      ...bunApiMatches.map(() => ({ file: "packages/agent-core/src/store/reduce.ts", importPath: "Bun.*" })),
    ];

    expectNoViolations(violations);
  });
});
