import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, relative, resolve } from "node:path";

const srcRoot = resolve(import.meta.dir, "..");
const packageRoot = resolve(srcRoot, "..");
const projectRoot = resolve(packageRoot, "../..");

interface ImportRecord {
  file: string;
  importPath: string;
  isTypeOnly: boolean;
  resolvedPath?: string;
  kind: "import" | "export-from" | "dynamic-import";
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
  const exportFromRegex = /export\s+(type\s+)?(?:[\s\S]*?\s+from\s+)["']([^"']+)["']/g;
  const dynamicImportRegex = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of source.matchAll(importRegex)) {
    const importPath = match[2];
    if (!importPath) continue;
    imports.push({
      file: filePath,
      importPath,
      isTypeOnly: match[1] !== undefined || /^import\s*\{\s*type\b/.test(match[0]),
      resolvedPath: resolveImportPath(filePath, importPath),
      kind: "import",
    });
  }

  for (const match of source.matchAll(exportFromRegex)) {
    const importPath = match[2];
    if (!importPath) continue;
    imports.push({
      file: filePath,
      importPath,
      isTypeOnly: match[1] !== undefined || /^export\s*\{\s*type\b/.test(match[0]),
      resolvedPath: resolveImportPath(filePath, importPath),
      kind: "export-from",
    });
  }

  for (const match of source.matchAll(dynamicImportRegex)) {
    const importPath = match[1];
    if (!importPath) continue;
    imports.push({
      file: filePath,
      importPath,
      isTypeOnly: false,
      resolvedPath: resolveImportPath(filePath, importPath),
      kind: "dynamic-import",
    });
  }

  return imports;
}

function resolveImportPath(filePath: string, importPath: string): string | undefined {
  if (importPath.startsWith(".")) return normalize(relative(projectRoot, resolve(filePath, "..", importPath)));
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

function readPackageDependencies(packageDir: string): Record<string, string> {
  const packageJson = JSON.parse(readFileSync(join(projectRoot, packageDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return packageJson.dependencies ?? {};
}

function findSourceTextViolations(scopeDir: string, patterns: RegExp[]): Violation[] {
  const scopePath = join(projectRoot, scopeDir);
  const violations: Violation[] = [];
  for (const file of findTsFiles(scopePath)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      if (pattern.test(source)) {
        violations.push({ file: normalize(relative(projectRoot, file)), importPath: pattern.source });
      }
    }
  }
  return violations;
}

function expectNoViolations(violations: Violation[]): void {
  const message = violations.map(({ file, importPath }) => `${file} -> ${importPath}`).join("\n");
  expect(violations, message).toEqual([]);
}

const utilsForbiddenPatterns = [
  /^@specra\/(agent-core|server|web)(\/|$)/,
  /^apps\//,
  /^packages\/(agent-core|server|web)(\/|$)/,
  /^packages\/(agent-core|server|web)\/src(\/|$)/,
  /^hono(\/|$)/,
  /^react(\/|$)/,
  /^react-dom(\/|$)/,
  /^node:/,
  /^bun:/,
  /^ai(\/|$)/,
  /^zustand(\/|$)/,
  /^zod(\/|$)/,
];

const utilsAllowedExceptions: RegExp[] = [];

describe("@specra/utils package boundaries", () => {
  test("utils has zero runtime dependencies", () => {
    expect(readPackageDependencies("packages/utils")).toEqual({});
  });

  test("utils source does not import forbidden packages", () => {
    expectNoViolations(findViolations("packages/utils/src", utilsForbiddenPatterns, utilsAllowedExceptions));
  });

  test("utils source does not call runtime identity/time/crypto APIs", () => {
    expectNoViolations(
      findSourceTextViolations("packages/utils/src", [
        /\bDate\.now\s*\(/,
        /\bnew\s+Date\b/,
        /\bcrypto\.randomUUID\s*\(/,
        /\bcrypto\.randomBytes\s*\(/,
        /\bconsole\.\w+\s*\(/,
      ]),
    );
  });

  test("utils source does not import node or bun runtimes", () => {
    expectNoViolations(
      findSourceTextViolations("packages/utils/src", [
        /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']node:/,
        /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']bun:/,
        /\brequire\s*\(\s*["']node:/,
        /\brequire\s*\(\s*["']bun:/,
      ]),
    );
  });
});