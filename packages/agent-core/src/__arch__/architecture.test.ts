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

    const isTestSource = entry.endsWith(".test.ts")
      || entry.endsWith(".test.tsx")
      || entry.endsWith(".interaction.ts")
      || entry.endsWith(".interaction.tsx");
    if (stats.isFile() && /\.tsx?$/.test(entry) && !isTestSource) {
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
  if (importPath.startsWith(".")) return normalize(relative(projectRoot, resolve(dirname(filePath), importPath)));
  if (importPath.startsWith("@archcode/protocol")) return "packages/protocol/src";
  if (importPath.startsWith("@archcode/utils")) return "packages/utils/src";
  if (importPath.startsWith("@archcode/agent-core")) return "packages/agent-core/src";
  if (importPath.startsWith("@archcode/server")) return "apps/server/src";
  if (importPath.startsWith("@archcode/web")) return "apps/web/src";
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

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function findProductionTextViolations(files: string[], patterns: RegExp[]): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(source)) {
        violations.push({ file: normalize(relative(projectRoot, file)), importPath: pattern.source });
      }
    }
  }

  return violations;
}

function findManagedLlmImportViolations(files: string[]): Violation[] {
  const violations: Violation[] = [];
  const managedImportRegex = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']ai["']/g;
  const managedRuntimeApis = /\b(streamText|generateText)\b/;

  for (const file of files) {
    const relativeFile = normalize(relative(projectRoot, file));
    if (relativeFile.startsWith("packages/agent-core/src/llm/")) continue;

    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(managedImportRegex)) {
      const namedImports = match[1] ?? "";
      if (managedRuntimeApis.test(namedImports)) {
        violations.push({ file: relativeFile, importPath: "{ streamText | generateText } from ai" });
      }
    }
  }

  return violations;
}

function findProductionFiles(scopeDir: string): string[] {
  return findTsFiles(join(projectRoot, scopeDir));
}

function findProductionAppFiles(scopeDir: string): string[] {
  return findProductionFiles(scopeDir).filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"));
}

function findProductionTextViolationsInScope(scopeDir: string, patterns: RegExp[]): Violation[] {
  return findProductionTextViolations(findProductionFiles(scopeDir), patterns);
}

// Boundary rules are enforced across static imports, re-exports, and dynamic imports.
const protocolForbiddenPatterns = [
  /^ai$/,
  /^zod(\/|$)/,
  /^zustand(\/|$)/,
  /^hono(\/|$)/,
  /^node:/,
  /^bun:/,
  /^react(\/|$)/,
  /^react-dom(\/|$)/,
  /^apps\//,
  /^@archcode\/(agent-core|server|web|utils)(\/|$)/,
  /^packages\/(agent-core|server|web|utils)(\/|$)/,
  /^packages\/(agent-core|server|web|utils)\/src(\/|$)/,
];

const agentCoreForbiddenPatterns = [
  /^hono(\/|$)/,
  /^apps\//,
  /^react(\/|$)/,
  /^react-dom(\/|$)/,
  /^@archcode\/(server|web)(\/|$)/,
  /^packages\/(server|web)(\/|$)/,
  /^packages\/(server|web)\/src(\/|$)/,
];

const serverForbiddenPatterns = [
  /^@archcode\/web(\/|$)/,
  /^react(\/|$)/,
  /^react-dom(\/|$)/,
  /^apps\/web(\/|$)/,
  /^packages\/[^/]+\/src(\/|$)/,
];

const serverAllowedExceptions = [/^@archcode\/(protocol|agent-core|utils)(\/|$)/, /^apps\/web\/dist(\/|$)/];

const webForbiddenPatterns = [
  /^@archcode\/(agent-core|server)(\/|$)/,
  /^node:/,
  /^bun:/,
  /^apps\/server(\/|$)/,
  /^apps\/server\/src\/routes(\/|$)/,
  /^packages\/agent-core\/src(\/|$)/,
  /^packages\/server\/src(\/|$)/,
  /^packages\/agent-core\/src\/execution(\/|$)/,
];

const serverInternalAgentCorePatterns = [
  /^\.\.\/\.\.\/\.\.\/packages\/agent-core\/src\//,
  /^packages\/agent-core\/src\//,
  /^@archcode\/agent-core\/src\//,
];

describe("monorepo package boundaries", () => {
  describe("source imports", () => {
    test("protocol has no runtime dependencies", () => {
      expectNoViolations(findViolations("packages/protocol/src", protocolForbiddenPatterns));
    });

    test("agent-core has no server/web dependencies", () => {
      expectNoViolations(findViolations("packages/agent-core/src", agentCoreForbiddenPatterns));
    });

    test("agent-core production code does not depend on test helpers", () => {
      expectNoViolations(findViolations("packages/agent-core/src", [/^testing(\/|$)/, /packages\/agent-core\/src\/testing(\/|$)/]));
    });

    test("server has no web/react dependencies", () => {
      expectNoViolations(findViolations("apps/server/src", serverForbiddenPatterns, serverAllowedExceptions));
    });

    test("web has no runtime/server dependencies", () => {
      expectNoViolations(findViolations("apps/web/src", webForbiddenPatterns));
    });

    test("server imports only the public agent-core API", () => {
      expectNoViolations(findViolations("apps/server/src", serverInternalAgentCorePatterns));
    });
  });

  describe("package dependency graph", () => {
    test("protocol package has zero runtime dependencies", () => {
      expect(readPackageDependencies("packages/protocol")).toEqual({});
    });

    test("utils package has zero runtime dependencies", () => {
      expect(readPackageDependencies("packages/utils")).toEqual({});
    });

    test("agent-core package does not depend on server or web packages", () => {
      const dependencies = readPackageDependencies("packages/agent-core");

      expect(dependencies).not.toHaveProperty("@archcode/server");
      expect(dependencies).not.toHaveProperty("@archcode/web");
    });

    test("web app does not depend on agent-core or server packages", () => {
      const dependencies = readPackageDependencies("apps/web");

      expect(dependencies).not.toHaveProperty("@archcode/agent-core");
      expect(dependencies).not.toHaveProperty("@archcode/server");
    });

    test("server app does not depend on web package", () => {
      expect(readPackageDependencies("apps/server")).not.toHaveProperty("@archcode/web");
    });
  });

  describe("protocol purity", () => {
    test("protocol source does not call runtime identity/time APIs", () => {
      expectNoViolations(
        findSourceTextViolations("packages/protocol/src", [
          /\bDate\.now\s*\(/,
          /\bcrypto\.randomUUID\s*\(/,
          /\bcrypto\.randomBytes\s*\(/,
        ]),
      );
    });

    test("protocol source does not import node or bun runtimes", () => {
      expectNoViolations(
        findSourceTextViolations("packages/protocol/src", [
          /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']node:/,
          /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']bun:/,
          /\brequire\s*\(\s*["']node:/,
          /\brequire\s*\(\s*["']bun:/,
        ]),
      );
    });

    test("protocol source has no schema, filesystem, server, web, or agent-core imports", () => {
      expectNoViolations(
        findViolations("packages/protocol/src", [
          /^zod(\/|$)/,
          /^node:(fs|path|os)(\/|$)/,
          /^bun:/,
          /^@archcode\/(agent-core|server|web)(\/|$)/,
          /^apps\/(server|web)(\/|$)/,
          /^packages\/(agent-core|server|web)\/src(\/|$)/,
        ]),
      );
    });
  });

  test("reduce isomorphism", () => {
    const reducePath = join(srcRoot, "store/reduce.ts");
    const imports = extractImports(reducePath).filter(({ importPath }) => importPath.startsWith("node:"));
    const bunApiMatches = readFileSync(reducePath, "utf8").match(/\bBun\./g) ?? [];
    const violations = [
      ...imports.map(formatViolation),
      ...bunApiMatches.map(() => ({ file: "packages/agent-core/src/store/reduce.ts", importPath: "Bun.*" })),
    ];

    expectNoViolations(
      violations,
    );
  });

  describe("session stats and sub-agent guardrails", () => {
    test("only the LLM runtime imports AI SDK stream/text execution APIs", () => {
      expectNoViolations(
        findManagedLlmImportViolations([
          ...findProductionFiles("apps/server/src"),
          ...findProductionFiles("apps/web/src"),
          ...findProductionFiles("packages/agent-core/src"),
          ...findProductionFiles("packages/protocol/src"),
        ]),
      );
    });

    test("AgentFactory stays free of store, bridge, and execution manager lifecycle ownership", () => {
      expectNoViolations(
        findProductionTextViolations([join(projectRoot, "packages/agent-core/src/agents/factory.ts")], [
          /SessionEventBridge/,
          /SessionExecutionManager/,
          /activeChildrenByParent/,
        ]),
      );
    });

    test("web production code does not parse legacy delegate metadata", () => {
      expectNoViolations(
        findProductionTextViolationsInScope("apps/web/src", [
          /<delegate_metadata>/,
          /delegate_metadata/,
          /parseDelegateMetadata/,
        ]),
      );
    });

    test("agent-core does not import server event bus or app modules", () => {
      expectNoViolations(findViolations("packages/agent-core/src", [
        /^\.\.\/\.\.\/\.\.\/apps\/(server|web)\//,
        /^apps\/(server|web)(\/|$)/,
        /^@archcode\/(server|web)(\/|$)/,
      ]));
    });

    test("production API surface has no public run graph routes or root-run identifiers", () => {
      expectNoViolations(
        findProductionTextViolations([
          ...findProductionAppFiles("apps/server/src"),
          ...findProductionAppFiles("apps/web/src"),
          ...findProductionAppFiles("packages/protocol/src"),
        ], [
          /\/api\/runs\b/,
          /\/api\/projects\/(?::slug|\$\{[^}]+\})\/runs\b/,
          /\bRunGraph\b/,
          /\bparentRunId\b/,
          /\brootRunId\b/,
        ]),
      );
    });

    test("child store operations do not import the global test-only storeManager", () => {
      const files = [
        ...findProductionFiles("packages/agent-core/src/agents"),
        join(projectRoot, "packages/agent-core/src/tools/builtins/background-output.ts"),
      ];

      expectNoViolations(
        findProductionTextViolations(files, [
          /import\s*\{[^}]*\bstoreManager\b[^}]*\}\s*from\s*["'][^"']*(?:\.\.\/store\/store|\.\.\/\.\.\/store\/store)["']/,
          /import\s+\{[^}]*\bstoreManager\b[^}]*\}\s+from\s+["'][^"']*\/store\/store["']/,
        ]),
      );
    });

    test("delegate metadata and protocol stats avoid legacy sub-agent fields", () => {
      const files = [
        join(projectRoot, "packages/protocol/src/types.ts"),
        join(projectRoot, "packages/agent-core/src/tools/builtins/delegate.ts"),
      ];

      expectNoViolations(
        findProductionTextViolations(files, [
          /\bsubAgentStats\b/,
          /\btask_id\b/,
          /\bbackground_task_id\b/,
        ]),
      );
    });

    test("protocol and web stats defaults keep strict package boundaries", () => {
      const violations = [
        ...findViolations("packages/protocol/src", [
          /^@archcode\/(agent-core|server|web)(\/|$)/,
          /^packages\/(agent-core|server|web)\/src(\/|$)/,
          /^apps\/(server|web)(\/|$)/,
        ]),
        ...findViolations("apps/web/src", [
          /^@archcode\/agent-core(\/|$)/,
          /^packages\/agent-core\/src(\/|$)/,
        ]),
      ];

      expectNoViolations(violations);
    });
  });
});
