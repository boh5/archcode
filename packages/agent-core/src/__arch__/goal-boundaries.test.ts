import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const srcRoot = resolve(import.meta.dir, "..");
const packageRoot = resolve(srcRoot, "..");
const projectRoot = resolve(packageRoot, "../..");

interface ImportRecord {
  file: string;
  importPath: string;
  resolvedPath?: string;
}

interface Violation {
  file: string;
  importPath: string;
}

interface SourceFile {
  file: string;
  source: string;
}

const legacyWorkflowImportPatterns = [
  /^packages\/agent-core\/src\/agents\/workflow(\/|$)/,
  /^packages\/agent-core\/src\/tools\/builtins\/workflow(\/|$)/,
  /(^|\/)agents\/workflow(\/|$)/,
  /(^|\/)tools\/builtins\/workflow(\/|$)/,
] as const;

const legacyWorkflowToolPatterns = [
  /\bworkflow_(?:create|read|update_stage|propose_interactions|request_interactions|task_check)\b/,
  /\bTOOL_WORKFLOW_(?:CREATE|READ|UPDATE_STAGE|PROPOSE_INTERACTIONS|REQUEST_INTERACTIONS|TASK_CHECK)\b/,
] as const;

const workflowStoragePathPatterns = [
  /["']\.archcode\/workflows\/?["']/,
  /["']\.archcode["']\s*,\s*["']workflows["']/,
] as const;

const serverWorkflowRoutePatterns = [
  /\bcreateWorkflowRoutes\b/,
  /\.route\s*\(\s*["']\/api\/(?:projects[^"']*\/)?workflows?\b/,
  /\.(?:post|put|patch|delete)\s*\(\s*["'][^"']*\/workflows?\b/,
] as const;

const webLegacyWorkflowUiImportPatterns = [
  /import\s+(?:type\s+)?[\s\S]*?\buseWorkflow\b[\s\S]*?from\s+["'][^"']+["']/,
  /import\s+(?:type\s+)?[\s\S]*?\bPipelineStepper\b[\s\S]*?from\s+["'][^"']+["']/,
  /import\s+(?:type\s+)?[\s\S]*?\bStateTab\b[\s\S]*?from\s+["'][^"']+["']/,
  /from\s+["'][^"']*(?:use-workflow|PipelineStepper|StateTab)[^"']*["']/,
] as const;

const legacyWorkflowToolDisplayFormatterFiles = new Set([
  "apps/web/src/lib/tool-format.ts",
]);

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

function readProductionSources(scopeDir: string): SourceFile[] {
  return findTsFiles(join(projectRoot, scopeDir)).map((file) => ({
    file,
    source: stripComments(readFileSync(file, "utf8")),
  }));
}

function readSpecificProductionSources(files: string[]): SourceFile[] {
  return files
    .filter((file) => existsSync(file) && !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
    .map((file) => ({ file, source: stripComments(readFileSync(file, "utf8")) }));
}

function resolveImportPath(filePath: string, importPath: string): string | undefined {
  if (!importPath.startsWith(".")) return importPath;
  return normalize(relative(projectRoot, resolve(dirname(filePath), importPath)));
}

function extractImports(filePath: string): ImportRecord[] {
  const source = readFileSync(filePath, "utf8");
  const imports: ImportRecord[] = [];
  const importRegex = /import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  const exportFromRegex = /export\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)["']([^"']+)["']/g;
  const dynamicImportRegex = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of source.matchAll(importRegex)) {
    const importPath = match[1];
    if (importPath) imports.push({ file: filePath, importPath, resolvedPath: resolveImportPath(filePath, importPath) });
  }

  for (const match of source.matchAll(exportFromRegex)) {
    const importPath = match[1];
    if (importPath) imports.push({ file: filePath, importPath, resolvedPath: resolveImportPath(filePath, importPath) });
  }

  for (const match of source.matchAll(dynamicImportRegex)) {
    const importPath = match[1];
    if (importPath) imports.push({ file: filePath, importPath, resolvedPath: resolveImportPath(filePath, importPath) });
  }

  return imports;
}

function relativeFile(filePath: string): string {
  return normalize(relative(projectRoot, filePath));
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function findImportViolations(scopeDir: string, forbiddenPatterns: readonly RegExp[]): Violation[] {
  const violations: Violation[] = [];

  for (const file of findTsFiles(join(projectRoot, scopeDir))) {
    for (const importRecord of extractImports(file)) {
      const candidates = [importRecord.importPath, importRecord.resolvedPath].filter(
        (candidate): candidate is string => candidate !== undefined,
      );
      if (candidates.some((candidate) => forbiddenPatterns.some((pattern) => pattern.test(candidate)))) {
        violations.push({ file: relativeFile(file), importPath: importRecord.importPath });
      }
    }
  }

  return violations;
}

function findSourceTextViolations(scopeDir: string, forbiddenPatterns: readonly RegExp[]): Violation[] {
  return findTextViolations(readProductionSources(scopeDir), forbiddenPatterns);
}

function findTextViolations(sources: SourceFile[], forbiddenPatterns: readonly RegExp[]): Violation[] {
  const violations: Violation[] = [];

  for (const { file, source } of sources) {
    for (const pattern of forbiddenPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(source)) {
        violations.push({ file: relativeFile(file), importPath: `source-pattern:${pattern.source}` });
      }
    }
  }

  return violations;
}

function withoutAllowedFiles(violations: Violation[], allowedFiles: ReadonlySet<string>): Violation[] {
  return violations.filter((violation) => !allowedFiles.has(violation.file));
}

function findWorkspaceTextViolations(scopeDirs: string[], forbiddenPatterns: readonly RegExp[]): Violation[] {
  return scopeDirs.flatMap((scopeDir) => findSourceTextViolations(scopeDir, forbiddenPatterns));
}

function expectNoViolations(violations: Violation[]): void {
  const message = violations.map(({ file, importPath }) => `${file} -> ${importPath}`).join("\n");
  expect(violations, message).toEqual([]);
}

function legacyWorkflowImplementationExists(): boolean {
  return existsSync(join(srcRoot, "agents/workflow")) || existsSync(join(srcRoot, "tools/builtins/workflow"));
}

describe("Goal migration boundaries", () => {
  test("goal-facing modules do not import legacy workflow domain or workflow tools", () => {
    const scopeDirs = ["packages/agent-core/src/goals", "packages/agent-core/src/hitl"];

    expectNoViolations(scopeDirs.flatMap((scopeDir) => findImportViolations(scopeDir, legacyWorkflowImportPatterns)));
  });

  test("goal-facing modules do not reference legacy workflow tool names", () => {
    const scopeDirs = ["packages/agent-core/src/goals", "packages/agent-core/src/hitl"];

    expectNoViolations(scopeDirs.flatMap((scopeDir) => findSourceTextViolations(scopeDir, legacyWorkflowToolPatterns)));
  });

  test("post-cutover production code has no active legacy workflow imports or workflow tools", () => {
    // Wave 1 keeps the legacy Workflow implementation alive. Once T14 deletes it,
    // this becomes a repo-wide production guard with no production allowlist.
    if (legacyWorkflowImplementationExists()) return;

    expectNoViolations([
      ...findImportViolations("packages/agent-core/src", legacyWorkflowImportPatterns),
      ...findSourceTextViolations("packages/agent-core/src", legacyWorkflowToolPatterns),
    ]);
  });

  test("production code does not reference legacy workflow tool names outside display formatters", () => {
    expectNoViolations(
      withoutAllowedFiles(
        findWorkspaceTextViolations([
          "apps/server/src",
          "apps/web/src",
          "packages/agent-core/src",
        ], legacyWorkflowToolPatterns),
        legacyWorkflowToolDisplayFormatterFiles,
      ),
    );
  });

  test("server app does not mount active workflow routes", () => {
    expectNoViolations(
      findTextViolations(
        readSpecificProductionSources([join(projectRoot, "apps/server/src/app.ts")]),
        serverWorkflowRoutePatterns,
      ),
    );
  });

  test("web production code does not import legacy workflow UI surfaces", () => {
    expectNoViolations(findSourceTextViolations("apps/web/src", webLegacyWorkflowUiImportPatterns));
  });

  test("runtime production code does not write legacy workflow storage paths", () => {
    expectNoViolations(
      findWorkspaceTextViolations([
        "apps/server/src",
        "apps/web/src",
        "packages/agent-core/src",
      ], workflowStoragePathPatterns),
    );
  });
});
