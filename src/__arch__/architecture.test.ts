import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const srcRoot = resolve(import.meta.dir, "..");
const projectRoot = resolve(srcRoot, "..");

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
  if (importPath.startsWith("src/")) return normalize(importPath);
  return undefined;
}

function findViolations(
  scopeDir: string,
  forbiddenPatterns: RegExp[],
  allowedExceptions: RegExp[] = [],
): Violation[] {
  const scopePath = join(projectRoot, scopeDir);
  const violations: Violation[] = [];

  for (const file of findTsFiles(scopePath)) {
    for (const importRecord of extractImports(file)) {
      const candidates = [importRecord.importPath, importRecord.resolvedPath].filter(
        (candidate): candidate is string => candidate !== undefined,
      );
      const isAllowed = candidates.some((candidate) =>
        allowedExceptions.some((pattern) => pattern.test(candidate)),
      );
      const isForbidden = candidates.some((candidate) =>
        forbiddenPatterns.some((pattern) => pattern.test(candidate)),
      );

      if (isForbidden && !isAllowed) {
        violations.push(formatViolation(importRecord));
      }
    }
  }

  return violations;
}

function findWebIsolationViolations(): Violation[] {
  const violations: Violation[] = [];
  const forbiddenPatterns = [/^node:/, /^bun:/, /^src\/(server|agents|lsp|mcp|tools)(\/|$)/];
  const allowedStoreFiles = new Set(["src/store/reduce", "src/store/types"]);

  for (const file of findTsFiles(join(srcRoot, "web"))) {
    if (file.endsWith("vite.config.ts")) continue;

    for (const importRecord of extractImports(file)) {
      const resolvedPath = importRecord.resolvedPath;
      const normalizedResolvedPath = resolvedPath?.replace(/\.(ts|tsx)$/, "");
      const candidates = [importRecord.importPath, normalizedResolvedPath].filter(
        (candidate): candidate is string => candidate !== undefined,
      );

      const importsStoreBoundary = normalizedResolvedPath?.startsWith("src/store/") ?? false;
      const allowedStoreImport = normalizedResolvedPath !== undefined && allowedStoreFiles.has(normalizedResolvedPath);
      const forbiddenByPattern = candidates.some((candidate) =>
        forbiddenPatterns.some((pattern) => pattern.test(candidate)),
      );

      if (forbiddenByPattern || (importsStoreBoundary && !allowedStoreImport)) {
        violations.push(formatViolation(importRecord));
      }
    }
  }

  return violations;
}

function findFeatureCrossImportViolations(): Violation[] {
  const featuresRoot = join(srcRoot, "web/src/components/features");
  const violations: Violation[] = [];

  for (const file of findTsFiles(featuresRoot)) {
    const sourceFeature = featureNameForPath(file);
    if (sourceFeature === undefined) continue;

    for (const importRecord of extractImports(file)) {
      if (importRecord.resolvedPath === undefined) continue;
      const targetFeature = featureNameForPath(join(projectRoot, importRecord.resolvedPath));

      if (targetFeature !== undefined && targetFeature !== sourceFeature) {
        violations.push(formatViolation(importRecord));
      }
    }
  }

  return violations;
}

function featureNameForPath(filePath: string): string | undefined {
  const relativePath = normalize(relative(join(srcRoot, "web/src/components/features"), filePath));
  if (relativePath.startsWith("..")) return undefined;
  const pathParts = relativePath.split(/[\\/]/);
  if (pathParts.length < 2) return undefined;
  const [featureName] = pathParts;
  return featureName || undefined;
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

describe("architecture boundaries", () => {
  test("agents isolation", () => {
    expectNoViolations(findViolations("src/agents", [/^src\/(web|server|tui)(\/|$)/]));
  });

  test("tools isolation", () => {
    expectNoViolations(findViolations("src/tools", [/^src\/(web|server|tui)(\/|$)/]));
  });

  test("reduce isomorphism", () => {
    const reducePath = join(srcRoot, "store/reduce.ts");
    const imports = extractImports(reducePath).filter(({ importPath }) => importPath.startsWith("node:"));
    const bunApiMatches = readFileSync(reducePath, "utf8").match(/\bBun\./g) ?? [];
    const violations = [
      ...imports.map(formatViolation),
      ...bunApiMatches.map(() => ({ file: "src/store/reduce.ts", importPath: "Bun.*" })),
    ];

    expectNoViolations(violations);
  });

  test("web isolation", () => {
    expectNoViolations(findWebIsolationViolations());
  });

  test("server isolation", () => {
    expectNoViolations(findViolations("src/server", [/^src\/(web|tui)(\/|$)/]));
  });

  test("primitives isolation", () => {
    expectNoViolations(
      findViolations("src/web/src/components/primitives", [
        /^src\/web\/src\/components\/(composite|features)(\/|$)/,
      ]),
    );
  });

  test("composite isolation", () => {
    expectNoViolations(
      findViolations("src/web/src/components/composite", [
        /^src\/web\/src\/components\/features(\/|$)/,
      ]),
    );
  });

  test("features isolation", () => {
    expectNoViolations(findFeatureCrossImportViolations());
  });
});
