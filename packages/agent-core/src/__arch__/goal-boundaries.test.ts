import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

import { agentDefinitions } from "../agents/definitions";
import { TOOL_GOAL_MANAGE } from "../tools/names";

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

const legacyArtifactToolPatterns = [
  /\bartifact_(?:read|write)\b/,
  /\bTOOL_ARTIFACT_(?:READ|WRITE)\b/,
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

const directGoalRunningTransitionPattern = /\.transitionStatus\s*\(\s*[^,]+,\s*["']running["']\s*\)/;

const directDoneResultRecordPattern = /\.recordDoneResult\s*\(/;

const directLifecycleMutationPatterns = [
  /\.transitionStatus\s*\(/,
  /\.updatePhase\s*\(/,
  /\.recordReviewOutcome\s*\(/,
  /\.complete\s*\(/,
  /\.startRetryAttempt\s*\(/,
] as const;

const activeGoalToolNames = [
  TOOL_GOAL_MANAGE,
] as const;

const removedGoalToolNames = [
  "goal_evidence",
  "goal_artifact_read",
  "goal_artifact_write",
] as const;

const removedGoalExecutableToolNames = [
  "goal_create",
  "goal_lock",
  "goal_run",
  "goal_retry",
  "goal_check_done",
] as const;

const fixedWorkflowSupervisorPatterns = [
  /\bGoalSupervisor\b/,
  /\bWorkflowSupervisor\b/,
  /\b(?:create|run|start)GoalSupervisor\b/,
  /\b(?:goal|workflow)SupervisorLoop\b/,
  /fixed\s+workflow\s+supervisor/i,
  /goal\s+supervisor/i,
] as const;

const rawLlmPersistenceFieldPatterns = [
  /\braw(?:Llm|LLM|Model|Reviewer)?(?:Output|Text|Transcript)\b/,
  /\bchain(?:OfThought|_of_thought)\b/,
  /\bprivate(?:Output|Text|Reasoning)\b/,
] as const;

const rawPrivateArtifactMarkerPatterns = [
  /RAW_MODEL_PRIVATE_TEXT/,
  /<\/?thinking>/i,
  /<\/?chain[-_ ]?of[-_ ]?thought>/i,
] as const;

const goalArtifactVersionPathPatterns = [
  /["']versions["']/,
  /["']revisions["']/,
  /["']latest(?:\.json)?["']/,
  /["'][^"']*(?:-v\d+|\.v\d+)[^"']*\.md["']/i,
] as const;

const goalMemoryProjectMutationPatterns = [
  /\bMemoryFileManager\b/,
  /["']\.archcode\/memory(?:\/|["'])/,
  /["']\.archcode["']\s*,\s*["']memory["']/,
] as const;

const workflowRegistrationPatterns = [
  /createWorkflow/i,
  /createArtifact(?:Read|Write)?Tool/,
  ...legacyWorkflowToolPatterns,
  ...legacyArtifactToolPatterns,
] as const;

const approvedDirectAiImportFiles = new Set([
  "packages/agent-core/src/agents/query/loop-hooks.ts",
  "packages/agent-core/src/agents/query/loop.ts",
  "packages/agent-core/src/compact/compact.ts",
  "packages/agent-core/src/compact/token-estimation.ts",
  "packages/agent-core/src/mcp/tool-adapter.ts",
  "packages/agent-core/src/provider/registry.ts",
  "packages/agent-core/src/store/projection.ts",
  "packages/agent-core/src/store/session-store-manager.ts",
  "packages/agent-core/src/store/types.ts",
  "packages/agent-core/src/tools/types.ts",
]);

const directGoalRunningTransitionAllowedFiles = new Set([
  "packages/agent-core/src/goals/runner.ts",
]);

const directDoneResultRecordAllowedFiles = new Set([
  "packages/agent-core/src/goals/runner.ts",
  "packages/agent-core/src/hitl/goal-gates.ts",
  "packages/agent-core/src/goals/hitl-resume-adapter.ts",
]);

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

function goalToolsFor(agentName: string): readonly string[] {
  const definition = agentDefinitions.find((candidate) => candidate.name === agentName);
  if (!definition) throw new Error(`Missing agent definition: ${agentName}`);
  return definition.tools.tools.filter((tool) => (activeGoalToolNames as readonly string[]).includes(tool));
}

function legacyWorkflowImplementationExists(): boolean {
  return existsSync(join(srcRoot, "agents/workflow")) || existsSync(join(srcRoot, "tools/builtins/workflow"));
}

function findFilesMatchingName(scopeDir: string, pattern: RegExp): string[] {
  return findTsFiles(join(projectRoot, scopeDir))
    .filter((file) => pattern.test(relativeFile(file)))
    .map(relativeFile);
}

function findDirectAiSdkImportViolations(): Violation[] {
  const violations: Violation[] = [];
  const staticAiImportLineRegex = /^\s*import\s+(?:type\s+)?(?:[^;\n]*\s+from\s+)?["']ai["']/;
  const dynamicAiImportRegex = /\bimport\s*\(\s*["']ai["']\s*\)/;

  for (const file of findTsFiles(join(projectRoot, "packages/agent-core/src"))) {
    const relativePath = relativeFile(file);
    if (relativePath.startsWith("packages/agent-core/src/llm/")) continue;

    const source = stripComments(readFileSync(file, "utf8"));
    const hasAiImport = source.split("\n").some((line) => staticAiImportLineRegex.test(line)) || dynamicAiImportRegex.test(source);
    if (hasAiImport && !approvedDirectAiImportFiles.has(relativePath)) {
      violations.push({ file: relativePath, importPath: "ai" });
    }
  }

  return violations;
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

  test("production code does not reference legacy artifact tool names", () => {
    expectNoViolations(
      findWorkspaceTextViolations([
        "apps/server/src",
        "apps/web/src",
        "packages/agent-core/src",
      ], legacyArtifactToolPatterns),
    );
  });

  test("web grouped tool display does not revive legacy artifact tool support", () => {
    expectNoViolations(
      findTextViolations(
        readSpecificProductionSources([join(projectRoot, "apps/web/src/components/composite/GroupedToolCard.tsx")]),
        legacyArtifactToolPatterns,
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

  test("production source tree has no legacy workflow implementation files", () => {
    expect([
      ...findFilesMatchingName("packages/agent-core/src", /(^|\/)workflow/i),
      ...findFilesMatchingName("apps/server/src", /(^|\/)workflow/i),
      ...findFilesMatchingName("apps/web/src", /(^|\/)workflow/i),
    ]).toEqual([]);
  });

  test("only GoalRunner production code claims Goal running status", () => {
    expectNoViolations(
      withoutAllowedFiles(
        findWorkspaceTextViolations([
          "apps/server/src",
          "packages/agent-core/src/tools/builtins",
          "packages/agent-core/src/goals",
        ], [directGoalRunningTransitionPattern]),
        directGoalRunningTransitionAllowedFiles,
      ),
    );
  });

  test("active Goal tool allowlists match the agent-driven lifecycle boundary", () => {
    expect(goalToolsFor("orchestrator")).toEqual([TOOL_GOAL_MANAGE]);
    expect(goalToolsFor("plan")).toEqual([]);
    expect(goalToolsFor("build")).toEqual([]);
    expect(goalToolsFor("reviewer")).toEqual([TOOL_GOAL_MANAGE]);
    expect(goalToolsFor("explore")).toEqual([]);
    expect(goalToolsFor("librarian")).toEqual([]);
  });

  test("removed Goal evidence and artifact tools are absent from all active allowlists", () => {
    for (const definition of agentDefinitions) {
      for (const toolName of removedGoalToolNames) {
        expect(definition.tools.tools).not.toContain(toolName);
      }
    }
  });

  test("goal_manage is exposed only to lifecycle roles", () => {
    const exposedTo = agentDefinitions
      .filter((definition) => (definition.tools.tools as readonly string[]).includes(TOOL_GOAL_MANAGE))
      .map((definition) => definition.name);

    expect(exposedTo).toEqual(["orchestrator", "reviewer"]);
  });

  test("Reviewer keeps finalization authority while non-review roles do not advertise it", () => {
    const reviewer = agentDefinitions.find((definition) => definition.name === "reviewer");
    if (!reviewer) throw new Error("Missing reviewer definition");

    expect(reviewer.tools.tools).toContain(TOOL_GOAL_MANAGE);
    expect(reviewer.rolePrompt).toContain("goal_manage.finalize_review");
    expect(reviewer.rolePrompt).toContain("DONE requires evidence");
    expect(reviewer.rolePrompt).toContain("Insufficient evidence means NOT_DONE");

    for (const definition of agentDefinitions.filter((candidate) => candidate.name !== "reviewer")) {
      expect(definition.rolePrompt).not.toContain("goal_manage.finalize_review");
    }
  });

  test("removed Goal executable names are absent from active agent allowlists and prompts", () => {
    for (const definition of agentDefinitions) {
      for (const toolName of removedGoalExecutableToolNames) {
        expect(definition.tools.tools).not.toContain(toolName);
        expect(definition.rolePrompt).not.toContain(toolName);
      }
    }
  });

  test("production Goal tools keep lifecycle mutations behind GoalRunner", () => {
    expectNoViolations(
      findSourceTextViolations("packages/agent-core/src/tools/builtins", directLifecycleMutationPatterns),
    );
  });

  test("production tool code does not directly record Goal done results", () => {
    expectNoViolations(findSourceTextViolations("packages/agent-core/src/tools", [directDoneResultRecordPattern]));
  });

  test("direct Goal done result recording remains behind runner and HITL review boundaries", () => {
    expectNoViolations(
      withoutAllowedFiles(
        findSourceTextViolations("packages/agent-core/src", [directDoneResultRecordPattern]),
        directDoneResultRecordAllowedFiles,
      ),
    );
  });

  test("production registration and server app do not revive workflow runtime tools or routes", () => {
    expectNoViolations(
      findTextViolations(
        readSpecificProductionSources([
          join(projectRoot, "packages/agent-core/src/core/register-tools.ts"),
          join(projectRoot, "apps/server/src/app.ts"),
        ]),
        [...workflowRegistrationPatterns, ...serverWorkflowRoutePatterns],
      ),
    );
  });

  test("production code does not introduce a fixed workflow supervisor", () => {
    expectNoViolations(
      findWorkspaceTextViolations([
        "apps/server/src",
        "packages/agent-core/src",
      ], fixedWorkflowSupervisorPatterns),
    );
  });

  test("spec artifacts and repair context schemas do not add raw LLM persistence fields", () => {
    expectNoViolations(
      findTextViolations(
        readSpecificProductionSources([
          join(projectRoot, "packages/protocol/src/types.ts"),
          join(projectRoot, "packages/agent-core/src/goals/state.ts"),
          join(projectRoot, "packages/agent-core/src/goals/artifact-lifecycle.ts"),
          join(projectRoot, "packages/agent-core/src/goals/operator-repair-context.ts"),
        ]),
        rawLlmPersistenceFieldPatterns,
      ),
    );
  });

  test("Goal artifact writers do not persist private-output markers or chain-of-thought tags", () => {
    expectNoViolations(
      findTextViolations(
        readSpecificProductionSources([
          join(projectRoot, "packages/agent-core/src/goals/artifact-lifecycle.ts"),
        ]),
        rawPrivateArtifactMarkerPatterns,
      ),
    );
  });

  test("Goal artifact implementation has no artifact version files, revision directories, or latest pointers", () => {
    expectNoViolations(
      findTextViolations(
        readSpecificProductionSources([
          join(projectRoot, "packages/agent-core/src/goals/artifacts.ts"),
          join(projectRoot, "packages/agent-core/src/goals/artifact-lifecycle.ts"),
          join(projectRoot, "apps/server/src/routes/goals.ts"),
        ]),
        goalArtifactVersionPathPatterns,
      ),
    );
  });

  test("Goal memory manager does not mutate Project memory storage or indexes", () => {
    expectNoViolations(
      findTextViolations(
        readSpecificProductionSources([join(projectRoot, "packages/agent-core/src/goals/goal-memory.ts")]),
        goalMemoryProjectMutationPatterns,
      ),
    );
  });

  test("direct AI SDK imports outside llm stay limited to approved schema/provider/type seams", () => {
    expectNoViolations(findDirectAiSdkImportViolations());
  });
});
