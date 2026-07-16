import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const srcRoot = resolve(import.meta.dir, "..");
const packageRoot = resolve(srcRoot, "..");
const projectRoot = resolve(packageRoot, "../..");

interface ImportRecord {
  file: string;
  importPath: string;
  source: string;
  kind: "import" | "export-from" | "dynamic-import";
}

interface Violation {
  file: string;
  importPath: string;
}

function findTsFiles(dir: string, options: { includeTests?: boolean } = {}): string[] {
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      if (entry === "dist" || entry === "__test_tmp__") continue;
      files.push(...findTsFiles(fullPath, options));
      continue;
    }

    const isTsFile = stats.isFile() && /\.tsx?$/.test(entry);
    const isTestFile = entry.endsWith(".test.ts") || entry.endsWith(".test.tsx");
    if (isTsFile && (options.includeTests || !isTestFile)) files.push(fullPath);
  }

  return files.sort();
}

function extractImports(filePath: string): ImportRecord[] {
  const source = readFileSync(filePath, "utf8");
  const imports: ImportRecord[] = [];
  const importRegex = /import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  const exportFromRegex = /export\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)["']([^"']+)["']/g;
  const dynamicImportRegex = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of source.matchAll(importRegex)) {
    const importPath = match[1];
    if (!importPath) continue;
    imports.push({ file: filePath, importPath, source: match[0], kind: "import" });
  }

  for (const match of source.matchAll(exportFromRegex)) {
    const importPath = match[1];
    if (!importPath) continue;
    imports.push({ file: filePath, importPath, source: match[0], kind: "export-from" });
  }

  for (const match of source.matchAll(dynamicImportRegex)) {
    const importPath = match[1];
    if (!importPath) continue;
    imports.push({ file: filePath, importPath, source: match[0], kind: "dynamic-import" });
  }

  return imports;
}

function relativeFile(filePath: string): string {
  return normalize(relative(projectRoot, filePath));
}

function expectNoViolations(violations: Violation[]): void {
  const message = violations.map(({ file, importPath }) => `${file} -> ${importPath}`).join("\n");
  expect(violations, message).toEqual([]);
}

function findExportedNames(source: string, names: readonly string[]): string[] {
  const violations = new Set<string>();
  const exportFromRegex = /export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']/g;

  for (const match of source.matchAll(exportFromRegex)) {
    const exportList = match[1] ?? "";
    const fromPath = match[2] ?? "unknown";

    for (const name of names) {
      const exportedNameRegex = new RegExp(`(?:^|,)\\s*(?:type\\s+)?${name}(?:\\s+as\\s+\\w+)?\\s*(?:,|$)`);
      if (exportedNameRegex.test(exportList)) violations.add(`${name} from ${fromPath}`);
    }
  }

  return [...violations].sort();
}

const forbiddenRootExports = [
  "createSessionStore",
  "getSessionsDir",
  "SessionAgentManager",
  "SessionFile",
  "storeManager",
  "SessionStoreManager",
  "scopedKey",
  "saveSessionTranscript",
  "readSessionFile",
  "SessionStoreState",
  "AgentJobRunner",
  "AgentRunner",
  "submitAgentJob",
  "abortAgentJob",
] as const;

const forbiddenExecutionExports = [
  "AgentJobRunner",
  "AgentRunner",
  "submitAgentJob",
  "abortAgentJob",
  "jobId",
] as const;

const forbiddenAgentExports = [
  "ConfiguredAgent",
  "ConfiguredAgentOptions",
  "QueryLoopOptions",
  "QueryLoopResult",
  "runQueryLoop",
] as const;

const forbiddenServerSymbols = [
  "StoreApi",
  "SessionStoreState",
  "saveSessionTranscript",
  "readSessionFile",
  "scopedKey",
] as const;

const rawBuiltinToolNames = [
  "ask_user",
  "ast_grep_replace",
  "ast_grep_search",
  "background_output",
  "bash",
  "delegate",
  "file_edit",
  "file_read",
  "file_write",
  "git_diff",
  "git_status",
  "glob",
  "grep",
  "lsp_diagnostics",
  "lsp_find_references",
  "lsp_goto_definition",
  "lsp_symbols",
  "memory_read",
  "memory_write",
  "skill_list",
  "skill_read",
  "todo_write",
  "view_tool_output",
  "wait_for_reminder",
  "web_fetch",
] as const;

function findPublicApiExportViolations(filePath: string, forbiddenNames: readonly string[]): Violation[] {
  const source = readFileSync(filePath, "utf8");
  return findExportedNames(source, forbiddenNames).map((exportedName) => ({
    file: relativeFile(filePath),
    importPath: `export:${exportedName}`,
  }));
}

function findServerBoundaryViolations(): Violation[] {
  const serverRoot = join(projectRoot, "apps/server/src");
  const violations: Violation[] = [];

  for (const file of findTsFiles(serverRoot, { includeTests: true })) {
    const source = readFileSync(file, "utf8");
    const imports = extractImports(file);

    for (const importRecord of imports) {
      if (importRecord.importPath === "zustand") {
        for (const symbol of forbiddenServerSymbols) {
          if (new RegExp(`\\b${symbol}\\b`).test(importRecord.source)) {
            violations.push({ file: relativeFile(file), importPath: `${symbol} from ${importRecord.importPath}` });
          }
        }
      }

      if (importRecord.importPath === "@archcode/agent-core") {
        for (const symbol of forbiddenServerSymbols) {
          if (new RegExp(`\\b${symbol}\\b`).test(importRecord.source)) {
            violations.push({ file: relativeFile(file), importPath: `${symbol} from ${importRecord.importPath}` });
          }
        }
      }
    }

    for (const match of source.matchAll(/\bruntime\.sessionAgentManager\b|\bthis\.#runtime\.sessionAgentManager\b/g)) {
      violations.push({ file: relativeFile(file), importPath: `source-pattern:${match[0]}` });
    }
  }

  return violations;
}

function findServerInternalAgentCoreImportViolations(): Violation[] {
  const serverRoot = join(projectRoot, "apps/server/src");
  const violations: Violation[] = [];

  for (const file of findTsFiles(serverRoot, { includeTests: true })) {
    for (const importRecord of extractImports(file)) {
      if (
        importRecord.importPath.startsWith("../../../packages/agent-core/src/")
        || importRecord.importPath.startsWith("packages/agent-core/src/")
        || importRecord.importPath.startsWith("@archcode/agent-core/src/")
      ) {
        violations.push({ file: relativeFile(file), importPath: importRecord.importPath });
      }
    }
  }

  return violations;
}

function findRawToolArrayViolations(): Violation[] {
  const files = [
    join(srcRoot, "agents/constants.ts"),
    join(srcRoot, "agents/workflow/permissions.ts"),
  ].filter((file) => existsSync(file));
  const violations: Violation[] = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const sourceLines = source.split("\n");

    for (const rawToolName of rawBuiltinToolNames) {
      const lineIndex = sourceLines.findIndex(
        (line) => line.includes(`"${rawToolName}"`) || line.includes(`'${rawToolName}'`),
      );
      if (lineIndex === -1) continue;

      const previousSource = sourceLines.slice(0, lineIndex + 1).join("\n");
      const ownerMatch = [...previousSource.matchAll(/(?:export\s+)?const\s+(\w+)\s*=\s*\[/g)].at(-1);
      const owner = ownerMatch?.[1] ?? "unknown";
      violations.push({ file: relativeFile(file), importPath: `source-pattern:raw built-in tool array ${owner} -> ${rawToolName}` });
    }
  }

  return violations;
}

function findToolNameSourceViolations(): Violation[] {
  const file = join(srcRoot, "tools/names.ts");
  const source = readFileSync(file, "utf8");
  const violations: Violation[] = [];

  if (!/from\s+["']@archcode\/protocol["']/.test(source)) {
    violations.push({
      file: relativeFile(file),
      importPath: "source-pattern:tool names must re-export protocol constants",
    });
  }

  for (const rawToolName of rawBuiltinToolNames) {
    if (source.includes(`= "${rawToolName}"`) || source.includes(`= '${rawToolName}'`)) {
      violations.push({
        file: relativeFile(file),
        importPath: `source-pattern:local built-in tool name literal -> ${rawToolName}`,
      });
    }
  }

  return violations;
}

function findLspProductionImportViolations(): Violation[] {
  const lspToolsRoot = join(srcRoot, "tools/builtins/lsp");
  const violations: Violation[] = [];

  for (const file of findTsFiles(lspToolsRoot)) {
    if (relative(dirname(file), lspToolsRoot) !== "" && dirname(file) !== lspToolsRoot) continue;

    for (const importRecord of extractImports(file)) {
      if (importRecord.importPath.startsWith("../../../lsp/") || importRecord.importPath === "../../../lsp") {
        if (importRecord.importPath !== "../../../lsp") {
          violations.push({ file: relativeFile(file), importPath: importRecord.importPath });
        }
      }
    }
  }

  return violations;
}

function findLspTestHelperImportViolations(): Violation[] {
  const lspToolsRoot = join(srcRoot, "tools/builtins/lsp");
  const violations: Violation[] = [];

  for (const file of findTsFiles(lspToolsRoot, { includeTests: true })) {
    if (!file.endsWith(".test.ts") && !file.endsWith(".test.tsx")) continue;

    for (const importRecord of extractImports(file)) {
      const importsFakeServer = /\bFakeLspServer\b/.test(importRecord.source);
      const usesTestUtilsPath = /\/test-utils(\/|$)/.test(importRecord.importPath);
      if (importsFakeServer && !usesTestUtilsPath) {
        violations.push({ file: relativeFile(file), importPath: importRecord.importPath });
      }
    }
  }

  return violations;
}

function findMemoryReadOwnershipViolations(): Violation[] {
  const file = join(srcRoot, "tools/builtins/memory-read.ts");
  const source = readFileSync(file, "utf8");
  const patterns = [/\bBun\.file\s*\(/, /\bparseFrontmatter\b/];

  return patterns
    .filter((pattern) => pattern.test(source))
    .map((pattern) => ({ file: relativeFile(file), importPath: `source-pattern:${pattern.source}` }));
}

function findAgentRunOwnershipViolations(): Violation[] {
  const owner = normalize(join("execution", "session-execution-manager.ts"));
  const allowedNonAgentReceivers = new Map<string, ReadonlySet<string>>([
    [normalize(join("binary", "installer.ts")), new Set(["input.runner", "runner"])],
    [normalize(join("binary", "manager.ts")), new Set(["runner"])],
    [normalize(join("worktrees", "service.ts")), new Set(["this.#git"])],
    [normalize(join("lsp", "installer.ts")), new Set(["createProcessRunner()"])],
    [normalize(join("tools", "builtins", "git-status.ts")), new Set(["createProcessRunner()"])],
    [normalize(join("tools", "builtins", "grep.ts")), new Set(["runner"])],
    [normalize(join("tools", "builtins", "glob.ts")), new Set(["runner"])],
    [normalize(join("tools", "builtins", "git-diff.ts")), new Set(["createProcessRunner()"])],
    [normalize(join("tools", "builtins", "bash.ts")), new Set(["createProcessRunner()"])],
    [normalize(join("tools", "builtins", "ast-grep", "search.ts")), new Set(["createProcessRunner()"])],
    [normalize(join("tools", "builtins", "ast-grep", "replace.ts")), new Set(["runner"])],
    [normalize(join("version-control", "detector.ts")), new Set(["processRunner"])],
    [normalize(join("agents", "query", "hooks", "title-generation.ts")), new Set(["task"])],
    [normalize(join("agents", "query", "hooks", "memory-extraction.ts")), new Set(["task"])],
    [normalize(join("agents", "query", "hooks", "memory-consolidation.ts")), new Set(["task"])],
  ]);
  const violations: Violation[] = [];
  for (const file of findTsFiles(srcRoot)) {
    const relativeToSrc = normalize(relative(srcRoot, file));
    if (relativeToSrc === owner) continue;
    const source = readFileSync(file, "utf8");
    const allowedReceivers = allowedNonAgentReceivers.get(relativeToSrc) ?? new Set<string>();
    for (const match of source.matchAll(/\b((?:this|[A-Za-z_$][\w$]*)(?:\.(?:#[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*))*(?:\(\))?)\.run\s*\(/g)) {
      const receiver = match[1];
      if (receiver !== undefined && !allowedReceivers.has(receiver)) {
        violations.push({
          file: relativeFile(file),
          importPath: `source-pattern:unclassified run capability ${receiver}.run outside SessionExecutionManager`,
        });
      }
    }
  }
  return violations;
}

function findExecutionLifecycleWriteViolations(): Violation[] {
  const allowedLifecycleReaders = new Set([
    normalize(join("execution", "session-execution-manager.ts")),
    // Session Input commits canonical input and its execution-start record atomically.
    normalize(join("session-input", "service.ts")),
    normalize(join("store", "reduce.ts")),
    normalize(join("store", "session-store-manager.ts")),
  ]);
  const violations: Violation[] = [];
  for (const file of findTsFiles(srcRoot)) {
    const relativeToSrc = normalize(relative(srcRoot, file));
    if (allowedLifecycleReaders.has(relativeToSrc)) continue;
    const source = readFileSync(file, "utf8");
    if (/["'`]execution-(?:start|end)["'`]/.test(source)) {
      violations.push({
        file: relativeFile(file),
        importPath: "source-pattern:execution lifecycle event construction outside owner or reducer",
      });
    }
  }
  return violations;
}

function findExecutionManagerLayerViolations(): Violation[] {
  const file = join(srcRoot, "execution/session-execution-manager.ts");
  return extractImports(file)
    .filter(({ importPath }) => (
      importPath.includes("apps/server")
      || importPath.includes("apps/web")
      || importPath.startsWith("@archcode/server")
      || importPath.startsWith("@archcode/web")
    ))
    .map(({ importPath }) => ({ file: relativeFile(file), importPath }));
}

function findSessionAgentManagerOwnershipViolations(): Violation[] {
  const file = join(srcRoot, "agents/session-agent-manager.ts");
  const source = readFileSync(file, "utf8");
  const forbiddenPatterns = [
    /\bactiveJobsByWorkspace\b/,
    /\bactiveSessionsByWorkspace\b/,
    /\bmaxConcurrentSessions\b/,
    /\bConcurrentSessionLimitError\b/,
    /\bacquireWorkspaceSlot\b/,
    /\breleaseWorkspaceSlot\b/,
    /\bdispatchCommand\b/,
  ];
  return forbiddenPatterns
    .filter((pattern) => pattern.test(source))
    .map((pattern) => ({ file: relativeFile(file), importPath: `source-pattern:${pattern.source}` }));
}

function findToolBatchDomainForwardingViolations(): Violation[] {
  const file = join(srcRoot, "execution/session-tool-batch-scheduler.ts");
  const source = readFileSync(file, "utf8");
  const violations = extractImports(file)
    .filter(({ importPath }) => /(?:^|\/)(?:goals|automations|hitl|events)(?:\/|$)/.test(importPath))
    .map(({ importPath }) => ({ file: relativeFile(file), importPath }));
  for (const pattern of [/\bGoalLifecycleService\b/, /\bglobalEventBus\b/, /\bemitGlobalEvent\b/]) {
    if (pattern.test(source)) {
      violations.push({ file: relativeFile(file), importPath: `source-pattern:${pattern.source}` });
    }
  }
  return violations;
}

function findDomainQueryReverseImportViolations(): Violation[] {
  const domainRoots = ["goals", "automations", "hitl", "todos", "projects"]
    .map((name) => join(srcRoot, name));
  const violations: Violation[] = [];
  for (const root of domainRoots) {
    for (const file of findTsFiles(root)) {
      for (const { importPath } of extractImports(file)) {
        if (/(?:^|\/)agents\/query(?:\/|$)/.test(importPath)) {
          violations.push({ file: relativeFile(file), importPath });
        }
      }
    }
  }
  return violations;
}

function findSessionInputBoundaryViolations(): Violation[] {
  const root = join(srcRoot, "session-input");
  const violations: Violation[] = [];
  for (const file of findTsFiles(root)) {
    for (const { importPath } of extractImports(file)) {
      if (/(?:^|\/)(?:execution|agents\/query|automations|server|web)(?:\/|$)/.test(importPath)
        || importPath === "../runtime") {
        violations.push({ file: relativeFile(file), importPath });
      }
    }
  }
  for (const file of findTsFiles(srcRoot)) {
    const relativePath = normalize(relative(srcRoot, file));
    if (relativePath.startsWith(`session-input${normalize("/")}`)
      || relativePath.startsWith(`store${normalize("/")}`)) continue;
    const source = readFileSync(file, "utf8");
    if (source.includes("inputRequestReceipts")) {
      violations.push({ file: relativeFile(file), importPath: "source-pattern:inputRequestReceipts" });
    }
    if (relativePath !== normalize(join("execution", "session-execution-manager.ts"))
      && source.includes("queueDispatchBarrierAt")) {
      violations.push({ file: relativeFile(file), importPath: "source-pattern:queueDispatchBarrierAt" });
    }
  }
  return violations;
}

describe("module migration boundary contracts", () => {
  describe("public API surface", () => {
    test("package indexes do not re-export private migration internals", () => {
      expectNoViolations([
        ...findPublicApiExportViolations(join(srcRoot, "index.ts"), forbiddenRootExports),
        ...findPublicApiExportViolations(join(srcRoot, "agents/index.ts"), forbiddenAgentExports),
        ...findPublicApiExportViolations(join(srcRoot, "execution/index.ts"), forbiddenExecutionExports),
      ]);
    });
  });

  describe("server boundary", () => {
    test("server sources do not reach into agent-core session store internals", () => {
      expectNoViolations(findServerBoundaryViolations());
    });

    test("server imports agent-core only through the package public API", () => {
      expectNoViolations(findServerInternalAgentCoreImportViolations());
    });
  });

  describe("LSP module boundary", () => {
    test("LSP built-ins use the lsp barrel and tests use explicit test-utils", () => {
      expectNoViolations([
        ...findLspProductionImportViolations(),
        ...findLspTestHelperImportViolations(),
      ]);
    });
  });

  describe("tool registry ownership", () => {
    test("agent permission modules import built-in tool names instead of declaring raw string arrays", () => {
      expectNoViolations(findRawToolArrayViolations());
    });

    test("agent-core tool names re-export protocol constants", () => {
      expectNoViolations(findToolNameSourceViolations());
    });
  });

  describe("memory owner boundary", () => {
    test("memory_read delegates memory file access and parsing to the memory module", () => {
      expectNoViolations(findMemoryReadOwnershipViolations());
    });
  });

  describe("execution ownership", () => {
    test("production Agent.run calls are owned by SessionExecutionManager", () => {
      expectNoViolations(findAgentRunOwnershipViolations());
    });

    test("production durable execution lifecycle writes are manager-owned", () => {
      expectNoViolations(findExecutionLifecycleWriteViolations());
    });

    test("SessionExecutionManager does not import Server or Web layers", () => {
      expectNoViolations(findExecutionManagerLayerViolations());
    });

    test("SessionAgentManager does not own live execution concurrency", () => {
      expectNoViolations(findSessionAgentManagerOwnershipViolations());
    });

    test("SessionToolBatchScheduler does not forward domain lifecycle events", () => {
      expectNoViolations(findToolBatchDomainForwardingViolations());
    });

    test("domain services do not reverse-import the Agent query loop", () => {
      expectNoViolations(findDomainQueryReverseImportViolations());
    });

    test("Session Input owns receipts and Queue barriers without reverse-importing runtime or execution", () => {
      expectNoViolations(findSessionInputBoundaryViolations());
    });
  });
});
