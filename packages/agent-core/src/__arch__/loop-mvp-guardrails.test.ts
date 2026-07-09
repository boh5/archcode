import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, relative, resolve } from "node:path";

const srcRoot = resolve(import.meta.dir, "..");
const packageRoot = resolve(srcRoot, "..");
const projectRoot = resolve(packageRoot, "../..");
const loopSourceRoot = join(projectRoot, "packages/agent-core/src/loops");
const toolSourceRoot = join(projectRoot, "packages/agent-core/src/tools");
const integrationSourceRoot = join(projectRoot, "packages/agent-core/src/integrations");
const protocolTypesFile = join(projectRoot, "packages/protocol/src/types.ts");
const protocolReduceFile = join(projectRoot, "packages/protocol/src/reduce.ts");
const loopStateFile = join(loopSourceRoot, "state.ts");
const loopTemplatesFile = join(loopSourceRoot, "templates.ts");
const loopPresetsFile = join(loopSourceRoot, "presets.ts");
const loopToolProfilesFile = join(loopSourceRoot, "tool-profiles.ts");
const loopRunnerFile = join(loopSourceRoot, "runner.ts");
const loopSchedulerFile = join(loopSourceRoot, "scheduler.ts");
const configuredAgentFile = join(projectRoot, "packages/agent-core/src/agents/configured-agent.ts");
const registerToolsFile = join(projectRoot, "packages/agent-core/src/core/register-tools.ts");
const toolRegistryFile = join(projectRoot, "packages/agent-core/src/tools/registry.ts");
const serverLoopsRouteFile = join(projectRoot, "apps/server/src/routes/loops.ts");
const serverDashboardRouteFile = join(projectRoot, "apps/server/src/routes/dashboard.ts");
const webCreateLoopDialogFile = join(projectRoot, "apps/web/src/components/features/CreateLoopDialog.tsx");
const webLoopsRouteFile = join(projectRoot, "apps/web/src/routes/loops.tsx");
const webLoopDetailRouteFile = join(projectRoot, "apps/web/src/routes/loop-detail.tsx");
const webDashboardRouteFile = join(projectRoot, "apps/web/src/routes/dashboard.tsx");

const supportedTemplateIds = ["watch_report", "maintain_fix", "pr_babysitter", "goal_runner"] as const;
const removedTemplateIds = [
  "daily_triage",
  "changelog_drafter",
  "ci_sweeper",
  "dependency_sweeper",
  "post_merge_cleanup",
  "issue_triage",
] as const;
const removedTemplateLabels = [
  "Daily Triage",
  "Changelog Drafter",
  "CI Sweeper",
  "Dependency Sweeper",
  "Post-Land Cleanup",
  "Issue Triage",
] as const;
const removedProfileIds = [
  "loop_local_report",
  "loop_local_maintenance",
  "loop_github_pr_watch",
  "loop_ci_watch",
  "loop_goal_action",
] as const;
const replacementProfileIds = [
  "loop_watch_report",
  "loop_maintain_fix",
  "loop_pr_babysitter",
  "loop_goal_runner",
] as const;
const forbiddenSelectorNames = ["mode", "capability", "behavior", "toolMode", "toolSet"] as const;
const forbiddenOrdinaryInputFields = [
  "extraTools",
  "mode",
  "toolProfileId",
  "config",
  "presetId",
  "collisionTargets",
  "cleanupPolicy",
] as const;
const primaryUiForbiddenLabels = [
  "runKind",
  "run kind",
  "mode",
  "toolProfileId",
  "tool profile",
  "extraTools",
  "collisionTargets",
  "collision targets",
  "cleanupPolicy",
  "cleanup policy",
  "trigger health",
  "queue:",
  "dedupeKey",
  "subjectKey",
  "branchKey",
] as const;

type Violation = {
  file: string;
  pattern: string;
};

const loopProductionFiles = [
  ...findTsFiles(loopSourceRoot),
  ...findTsFiles(join(projectRoot, "packages/agent-core/src/agents")).filter((file) => file.endsWith("configured-agent.ts") || file.endsWith("types.ts")),
  ...findTsFiles(join(projectRoot, "packages/agent-core/src/execution")).filter((file) => file.endsWith("session-execution-manager.ts")),
  registerToolsFile,
  toolRegistryFile,
  ...findTsFiles(join(projectRoot, "apps/server/src/routes")).filter((file) => /(?:loops|dashboard)\.ts$/.test(file)),
  ...findTsFiles(join(projectRoot, "apps/web/src/api")),
  ...findTsFiles(join(projectRoot, "apps/web/src/routes")).filter((file) => /(?:loops|loop-detail|dashboard)\.tsx$/.test(file)),
  webCreateLoopDialogFile,
  protocolTypesFile,
  protocolReduceFile,
].filter((file) => existsSync(file));

const loopContractFiles = [
  loopStateFile,
  loopTemplatesFile,
  protocolTypesFile,
  serverLoopsRouteFile,
  serverDashboardRouteFile,
  webCreateLoopDialogFile,
  webLoopsRouteFile,
  webLoopDetailRouteFile,
  webDashboardRouteFile,
].filter((file) => existsSync(file));

const loopRuntimeSelectorFiles = [loopRunnerFile, loopSchedulerFile, configuredAgentFile, toolRegistryFile].filter((file) => existsSync(file));
const loopRunnerBoundaryFiles = [loopRunnerFile, loopSchedulerFile].filter((file) => existsSync(file));
const connectorDescriptorFiles = [
  ...findTsFiles(toolSourceRoot),
  ...findTsFiles(integrationSourceRoot),
];

function findTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (entry === "dist" || entry === "__tests__" || entry === "__test_tmp__") continue;
      files.push(...findTsFiles(fullPath));
      continue;
    }

    if (
      stats.isFile() &&
      /\.tsx?$/.test(entry) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx") &&
      !entry.endsWith("test-utils.ts")
    ) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function relativeFile(filePath: string): string {
  return normalize(relative(projectRoot, filePath));
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function readProductionSource(filePath: string): string {
  return stripComments(readFileSync(filePath, "utf8"));
}

function readProductionSourceIfExists(filePath: string): string {
  return existsSync(filePath) ? readProductionSource(filePath) : "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalPatterns(values: readonly string[]): RegExp[] {
  return values.map((value) => new RegExp(escapeRegExp(value)));
}

function fieldOrStringPatterns(fields: readonly string[]): RegExp[] {
  return fields.flatMap((field) => [
    new RegExp(`\\b${escapeRegExp(field)}\\??\\s*:`),
    new RegExp(`\\.${escapeRegExp(field)}\\b`),
    new RegExp(`["']${escapeRegExp(field)}["']`),
  ]);
}

function findTextViolations(
  files: string[],
  patterns: RegExp[],
  allow: (file: string, source: string, pattern: RegExp) => boolean = () => false,
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const source = readProductionSource(file);
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(source) && !allow(relativeFile(file), source, pattern)) {
        violations.push({ file: relativeFile(file), pattern: pattern.source });
      }
    }
  }
  return violations;
}

function expectNoViolations(violations: Violation[]): void {
  const message = violations.map(({ file, pattern }) => `${file} -> ${pattern}`).join("\n");
  expect(violations, message || "expected no architecture violations").toEqual([]);
}

function sourceSection(filePath: string, start: string, end: string): string {
  const source = readProductionSource(filePath);
  const startIndex = source.indexOf(start);
  if (startIndex < 0) throw new Error(`Missing section start "${start}" in ${relativeFile(filePath)}`);
  const endIndex = source.indexOf(end, startIndex);
  if (endIndex < 0) throw new Error(`Missing section end "${end}" in ${relativeFile(filePath)}`);
  return source.slice(startIndex, endIndex);
}

function sourceFromMarker(filePath: string, start: string): string {
  const source = readProductionSource(filePath);
  const startIndex = source.indexOf(start);
  if (startIndex < 0) throw new Error(`Missing section start "${start}" in ${relativeFile(filePath)}`);
  return source.slice(startIndex);
}

function extractStringArrayAfterName(source: string, name: string): string[] {
  const nameIndex = source.indexOf(name);
  if (nameIndex < 0) return [];
  const openBracket = source.indexOf("[", nameIndex);
  if (openBracket < 0) return [];

  let depth = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  for (let index = openBracket; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "[") depth += 1;
    if (char !== "]") continue;

    depth -= 1;
    if (depth === 0) {
      const arraySource = source.slice(openBracket, index + 1);
      return [...arraySource.matchAll(/["']([a-z][a-z0-9_]*?)["']/g)].map((match) => match[1]).filter((value): value is string => value !== undefined);
    }
  }

  return [];
}

function extractDeclaredTemplateIds(source: string): string[] {
  for (const name of ["SUPPORTED_LOOP_TEMPLATE_IDS", "LOOP_TEMPLATE_IDS", "LOOP_TEMPLATES"] as const) {
    const ids = extractStringArrayAfterName(source, name);
    if (ids.length > 0) return [...new Set(ids)].sort();
  }

  return [...new Set([...source.matchAll(/\b(?:templateId|id)\s*:\s*["']([a-z][a-z0-9_]*?)["']/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined))].sort();
}

function primarySourceBeforeAdvancedDebug(filePath: string): string {
  const source = readProductionSource(filePath);
  const debugIndex = source.search(/Advanced Debug|advanced debug/i);
  return debugIndex < 0 ? source : source.slice(0, debugIndex);
}

function extractDefineToolObjectBlocks(source: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  const marker = "defineTool";

  while (cursor < source.length) {
    const callIndex = source.indexOf(marker, cursor);
    if (callIndex < 0) break;
    const openParen = source.indexOf("(", callIndex + marker.length);
    const openBrace = openParen < 0 ? -1 : source.indexOf("{", openParen);
    if (openParen < 0 || openBrace < 0) {
      cursor = callIndex + marker.length;
      continue;
    }

    let depth = 0;
    let quote: '"' | "'" | "`" | undefined;
    let escaped = false;
    for (let index = openBrace; index < source.length; index += 1) {
      const char = source[index];
      if (quote !== undefined) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = undefined;
        }
        continue;
      }

      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") depth += 1;
      if (char !== "}") continue;

      depth -= 1;
      if (depth === 0) {
        blocks.push(source.slice(openBrace, index + 1));
        cursor = index + 1;
        break;
      }
    }

    if (cursor <= callIndex) cursor = callIndex + marker.length;
  }

  return blocks;
}

function findConnectorMutatingToolDescriptorViolations(files: string[]): Violation[] {
  const violations: Violation[] = [];
  const connectorNamePattern = /name\s*:\s*(?:["'](?:github|github_actions|actions)_|TOOL_GITHUB_|TOOL_GITHUB_ACTIONS_)/i;
  const mutatingNamePattern = /CREATE|UPDATE|DELETE|RERUN|CANCEL|MERGE|APPROVE|LABEL|ASSIGN|CLOSE|REOPEN|PUSH|REBASE|create|update|delete|rerun|cancel|merge|approve|label|assign|close|reopen|push|rebase/;

  for (const file of files) {
    const source = readProductionSource(file);
    for (const block of extractDefineToolObjectBlocks(source)) {
      if (!connectorNamePattern.test(block) || !mutatingNamePattern.test(block)) continue;

      if (!/readOnly\s*:\s*false/.test(block)) {
        violations.push({ file: relativeFile(file), pattern: "mutating connector descriptor must set traits.readOnly false" });
      }
      if (!/permissions\s*:\s*\[(?!\s*\])/.test(block)) {
        violations.push({ file: relativeFile(file), pattern: "mutating connector descriptor must declare permissions/HITL coverage" });
      }
    }
  }

  return violations;
}

describe("Loop simplified target-model architecture guardrails", () => {
  test("Loop templates are exactly the four simplified template ids", () => {
    expect(existsSync(loopTemplatesFile), "Loop templates must live in packages/agent-core/src/loops/templates.ts").toBe(true);

    const templateSource = readProductionSourceIfExists(loopTemplatesFile);
    const declaredIds = extractDeclaredTemplateIds(templateSource);
    expect(declaredIds).toEqual([...supportedTemplateIds].sort());
    for (const templateId of supportedTemplateIds) {
      expect(templateSource).toContain(templateId);
    }
  });

  test("removed template ids are not exposed as valid template or create-dialog options", () => {
    const positiveTemplateSurfaces = [
      loopTemplatesFile,
      loopPresetsFile,
      protocolTypesFile,
      serverLoopsRouteFile,
      webCreateLoopDialogFile,
    ].filter((file) => existsSync(file));

    expectNoViolations(findTextViolations(positiveTemplateSurfaces, literalPatterns(removedTemplateIds)));
    expectNoViolations(findTextViolations([webCreateLoopDialogFile].filter((file) => existsSync(file)), literalPatterns(removedTemplateLabels)));
  });

  test("removed and replacement Loop tool profile ids are absent from production surfaces", () => {
    expectNoViolations(findTextViolations(loopProductionFiles, literalPatterns(removedProfileIds)));
    expectNoViolations(findTextViolations(loopProductionFiles, literalPatterns(replacementProfileIds)));
    expect(existsSync(loopToolProfilesFile), "Loop tool profiles must be deleted or fully disconnected from production").toBe(false);
  });

  test("Loop config, templates, protocol, and runtime expose no mode-like selector", () => {
    expectNoViolations(findTextViolations(loopContractFiles, fieldOrStringPatterns(forbiddenSelectorNames)));
    expectNoViolations(findTextViolations(loopRuntimeSelectorFiles, fieldOrStringPatterns(forbiddenSelectorNames)));
    expectNoViolations(findTextViolations(loopRuntimeSelectorFiles, [
      /origin\.mode\b/,
      /origin\?\.mode\b/,
      /\bLoopMode\b/,
    ]));
  });

  test("ordinary create and update schemas reject removed raw inputs and user supplied extraTools", () => {
    const createSchemaSource = sourceSection(serverLoopsRouteFile, "const CreateLoopBodySchema", "const PatchLoopBodySchema");
    const patchSchemaSource = sourceSection(serverLoopsRouteFile, "const PatchLoopBodySchema", "const ActivateKillBodySchema");

    expect(createSchemaSource).toMatch(/z\.strictObject\s*\(/);
    expect(createSchemaSource).toMatch(/\btemplateId\??\s*:/);
    for (const field of forbiddenOrdinaryInputFields) {
      const fieldPattern = new RegExp(`\\b${escapeRegExp(field)}\\??\\s*:`);
      expect(createSchemaSource, `${field} must not be an accepted create-loop field`).not.toMatch(fieldPattern);
    }

    expect(patchSchemaSource).toMatch(/z\.strictObject\s*\(/);
    for (const field of forbiddenOrdinaryInputFields) {
      const fieldPattern = new RegExp(`\\b${escapeRegExp(field)}\\??\\s*:`);
      expect(patchSchemaSource, `${field} must not be an accepted update-loop field`).not.toMatch(fieldPattern);
    }
  });

  test("template-owned extraTools stay internal and public schemas cannot accept them", () => {
    const templateSource = readProductionSourceIfExists(loopTemplatesFile);
    const protocolSource = readProductionSource(protocolTypesFile);
    const serverCreateSchemaSource = sourceSection(serverLoopsRouteFile, "const CreateLoopBodySchema", "const PatchLoopBodySchema");
    const serverPatchSchemaSource = sourceSection(serverLoopsRouteFile, "const PatchLoopBodySchema", "const ActivateKillBodySchema");
    const webCreateSource = readProductionSource(webCreateLoopDialogFile);

    expect(templateSource).toMatch(/\bextraTools\s*:/);
    expect(templateSource).toMatch(/\bPR_BABYSITTER_EXTRA_TOOLS\b/);
    expect(protocolSource).not.toMatch(/^\s*extraTools\??:\s*(?:readonly\s+)?string\[\]/m);
    expect(serverCreateSchemaSource).not.toMatch(/\bextraTools\??\s*:/);
    expect(serverPatchSchemaSource).not.toMatch(/\bextraTools\??\s*:/);
    expect(webCreateSource).not.toMatch(/\bextraTools\b/);
  });

  test("ConfiguredAgent tool selection is explicit extraTools merge, not Loop-origin profile filtering", () => {
    const configuredAgentSource = readProductionSource(configuredAgentFile);
    const toolResolutionSource = sourceFromMarker(configuredAgentFile, "resolveEffectiveTools");

    expect(configuredAgentSource).not.toMatch(/resolveLoopToolProfile/);
    expect(configuredAgentSource).not.toMatch(/origin\.toolProfileId\b|origin\?\.toolProfileId\b/);
    expect(configuredAgentSource).not.toMatch(/origin\.mode\b|origin\?\.mode\b/);
    expect(toolResolutionSource).not.toMatch(/origin\?\.kind\s*!==\s*["']loop["']|origin\?\.kind\s*===\s*["']loop["']|origin\.kind\s*===\s*["']loop["']/);
    expect(toolResolutionSource).not.toMatch(/\btoolProfileId\b/);
    expect(toolResolutionSource).toMatch(/\bextraTools\b/);
  });

  test("origin remains metadata, not a mode/profile selector for runtime permissions or tool selection", () => {
    const runtimeOriginFiles = [configuredAgentFile, toolRegistryFile, loopRunnerFile, loopSchedulerFile].filter((file) => existsSync(file));

    expectNoViolations(findTextViolations(runtimeOriginFiles, [
      /origin\.toolProfileId\b/,
      /origin\?\.toolProfileId\b/,
      /origin\.mode\b/,
      /origin\?\.mode\b/,
      /origin\?\.kind\s*===\s*["']loop["']\s*&&\s*origin\.mode/,
      /origin\.kind\s*===\s*["']loop["']\s*&&\s*origin\.mode/,
    ]));
  });

  test("default tool registry does not install the removed tool-level Loop collision guard", () => {
    const registerToolsSource = readProductionSource(registerToolsFile);

    expect(registerToolsSource).not.toMatch(/createLoopCollisionToolPermission/);
    expect(registerToolsSource).not.toMatch(/createLoopCollisionToolReleaseHook/);
    expect(registerToolsSource).not.toMatch(/collision-tool-guard/);
    expect(registerToolsSource).not.toMatch(/globalPermissions\.push\([^)]*LoopCollision/i);
    expect(registerToolsSource).not.toMatch(/globalHooks\.after\.push\([^)]*LoopCollision/i);
  });

  test("Loop worktree isolation is manual-only through useWorktree", () => {
    const loopStateSource = readProductionSource(loopStateFile);
    const protocolSource = readProductionSource(protocolTypesFile);
    const runnerSource = readProductionSource(loopRunnerFile);

    expect(loopStateSource).toMatch(/\buseWorktree\s*:/);
    expect(protocolSource).toMatch(/\buseWorktree\??:\s*boolean/);
    expect(runnerSource).toMatch(/useWorktree\s*={2,3}\s*true/);
    expectNoViolations(findTextViolations(loopProductionFiles, [
      /\bworktreeMode\b/,
      /\bworktreePolicy\b/,
      /\bautoWorktree\b/,
      /\binfer(?:red)?Worktree\b/i,
      /\bshouldUseWorktree\b[\s\S]{0,200}\b(?:trigger|schedule|sha|dirty|remote|template)\b/i,
      /\b(?:trigger|schedule|sha|dirty|remote|template)\b[\s\S]{0,200}\bshouldUseWorktree\b/i,
    ]));
  });

  test("Loop primary UI surfaces do not expose raw internals or Automation wording", () => {
    const userFacingLoopFiles = [
      webCreateLoopDialogFile,
      webLoopsRouteFile,
      webLoopDetailRouteFile,
      webDashboardRouteFile,
      serverLoopsRouteFile,
      serverDashboardRouteFile,
    ].filter((file) => existsSync(file));
    expectNoViolations(findTextViolations(userFacingLoopFiles, [/\bAutomation\b/, /\bAutomations\b/]));

    const createSource = readProductionSource(webCreateLoopDialogFile);
    expectNoViolations(findTextViolations([webCreateLoopDialogFile], [
      ...literalPatterns(removedTemplateIds),
      ...literalPatterns(removedTemplateLabels),
      ...fieldOrStringPatterns(["runKind", "mode", "toolProfileId", "extraTools", "collisionTargets", "cleanupPolicy"]),
    ]));
    for (const templateId of supportedTemplateIds) {
      expect(createSource).toContain(templateId);
    }

    for (const file of [webLoopsRouteFile, webDashboardRouteFile, webLoopDetailRouteFile]) {
      const primarySource = primarySourceBeforeAdvancedDebug(file);
      for (const label of primaryUiForbiddenLabels) {
        expect(primarySource, `${relativeFile(file)} exposes ${label} before Advanced Debug`).not.toContain(label);
      }
    }
  });

  test("Loop runtime has no readiness maturity gates or compatibility state", () => {
    expectNoViolations(findTextViolations(loopProductionFiles, [
      /\bcalculateReadiness\b/,
      /\bpromoteLoop\b/,
      /\bgraduateLoop\b/,
      /\bgraduation\b/,
      /\bnoiseRate\b/,
      /\breadiness\s*[:=]\s*(?:Math\.|Number\(|\d)/,
      /\breadinessScore\b/,
    ]));
  });

  test("Loop runner and scheduler do not bypass connector or GitHub API tool boundaries", () => {
    expectNoViolations(findTextViolations(loopRunnerBoundaryFiles, [
      /from\s+["'][^"']*(?:integrations\/github|connectors\/github|github-actions|\/github)[^"']*["']/i,
      /import\s*\(\s*["'][^"']*(?:integrations\/github|connectors\/github|github-actions|\/github)[^"']*["']\s*\)/i,
      /https:\/\/api\.github\.com/,
      /fetch\s*\(\s*["'`]https:\/\/api\.github\.com/,
    ]));
  });

  test("Loop runner and scheduler do not directly orchestrate git push, merge, or rebase", () => {
    expectNoViolations(findTextViolations(loopRunnerBoundaryFiles, [
      /["'`]\s*git\s+(?:push|merge|rebase)\b/i,
      /["']git["']\s*,\s*["'](?:push|merge|rebase)["']/i,
    ]));
  });

  test("future mutating connector tool descriptors must be effectful and permission-gated", () => {
    expectNoViolations(findConnectorMutatingToolDescriptorViolations(connectorDescriptorFiles));
  });

  test("excluded future customization concepts stay out of Loop production surfaces", () => {
    expectNoViolations(findTextViolations(loopProductionFiles, [
      /\bcustomPattern(?:Path|Registry|Profile|Script|Hooks?|Dsl|DSL)?\b/,
      /\bpattern(?:Registry|Profile|Script|Hooks?|Dsl|DSL)\b/,
      /\bcustomToolProfile(?:Path|Registry|Script|Hooks?|Dsl|DSL)?\b/,
      /\btoolProfile(?:Registry|Script|Hooks?|Dsl|DSL)\b/,
      /\bautoApprove\b/,
      /\bautoApproval\b/,
      /auto[-_\s]?approval/i,
      /\bapproveAutomatically\b/,
      /\breadiness(?:Gate|Scheduler|Signals|Threshold)\b/,
      /\bminReadiness\b/,
      /\bcanRunByReadiness\b/,
      /\breadiness\s*[:=]\s*(?:Math\.|Number\(|\d)/,
    ]));
  });
});
