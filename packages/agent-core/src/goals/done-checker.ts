import { access, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { DoneCondition, DoneResult } from "@archcode/protocol";
import { createProcessRunner } from "../process/runner";
import type { ProcessRunnerResult } from "../process/types";
import { classifyCommand } from "../tools/security";
import type { ToolConfirmationCallback } from "../tools/types";
import { MAX_DONE_COMMAND_TIMEOUT_MS } from "./state";

const DEFAULT_TEST_COMMAND = "bun test";
const DEFAULT_TYPECHECK_COMMAND = "bun run typecheck";
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_EVIDENCE_LENGTH = 8_000;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".turbo", ".next", "__test_tmp__"]);
const GREP_MAX_FILES = 500;
const ENV_ALLOWLIST = ["PATH", "HOME", "SHELL", "TERM", "LANG", "LC_ALL"] as const;

export interface EvaluateConditionOptions {
  readonly confirmPermission?: ToolConfirmationCallback;
  readonly abort?: AbortSignal;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly checkCommandPermission?: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export async function evaluateCondition(
  condition: DoneCondition,
  workspaceRoot: string,
  options: EvaluateConditionOptions = {},
): Promise<DoneResult> {
  switch (condition.kind) {
    case "tests_pass": {
      const result = await runShellCommand(condition.params.command ?? DEFAULT_TEST_COMMAND, workspaceRoot, DEFAULT_COMMAND_TIMEOUT_MS, options);
      return doneResult(condition.id, result.exitCode === 0, formatCommandEvidence(result));
    }
    case "typecheck_pass": {
      const result = await runShellCommand(condition.params.command ?? DEFAULT_TYPECHECK_COMMAND, workspaceRoot, DEFAULT_COMMAND_TIMEOUT_MS, options);
      return doneResult(condition.id, result.exitCode === 0, formatCommandEvidence(result));
    }
    case "lsp_clean":
      return evaluateLspClean(condition, workspaceRoot);
    case "file_exists":
      return evaluateFileExists(condition, workspaceRoot);
    case "grep_contains":
      return evaluateGrepContains(condition, workspaceRoot);
    case "grep_empty":
      return evaluateGrepEmpty(condition, workspaceRoot);
    case "command_succeeds": {
      const result = await runShellCommand(condition.params.command, workspaceRoot, condition.params.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, options);
      return doneResult(condition.id, result.exitCode === 0, formatCommandEvidence(result));
    }
    case "user_confirmed":
      return doneResult(condition.id, true, "user_confirmed: awaiting HITL");
    case "spec_compliance":
      return doneResult(condition.id, false, "spec_compliance is not implemented in Phase 1");
  }
}

async function evaluateFileExists(
  condition: Extract<DoneCondition, { kind: "file_exists" }>,
  workspaceRoot: string,
): Promise<DoneResult> {
  const resolvedPath = resolveWorkspacePath(workspaceRoot, condition.params.path);
  const exists = await pathExists(resolvedPath);
  return doneResult(condition.id, exists, `${condition.params.path}: exists=${exists}`);
}

async function evaluateGrepContains(
  condition: Extract<DoneCondition, { kind: "grep_contains" }>,
  workspaceRoot: string,
): Promise<DoneResult> {
  const matches = await collectGrepMatches(workspaceRoot, condition.params.path ?? ".", condition.params.pattern);
  const minMatches = condition.params.minMatches ?? 1;
  return doneResult(
    condition.id,
    matches.length >= minMatches,
    formatGrepEvidence(matches, `${matches.length} matches (minimum required: ${minMatches})`),
  );
}

async function evaluateGrepEmpty(
  condition: Extract<DoneCondition, { kind: "grep_empty" }>,
  workspaceRoot: string,
): Promise<DoneResult> {
  const matches = await collectGrepMatches(workspaceRoot, condition.params.path ?? ".", condition.params.pattern);
  return doneResult(condition.id, matches.length === 0, formatGrepEvidence(matches, `${matches.length} matches`));
}

async function evaluateLspClean(
  condition: Extract<DoneCondition, { kind: "lsp_clean" }>,
  workspaceRoot: string,
): Promise<DoneResult> {
  const paths = condition.params.paths && condition.params.paths.length > 0 ? condition.params.paths : ["."];
  const severity = condition.params.severity ?? "error";
  const diagnostics: string[] = [];
  const failures: string[] = [];

  for (const inputPath of paths) {
    const resolvedPath = resolveWorkspacePath(workspaceRoot, inputPath);
    if (!(await pathExists(resolvedPath))) {
      failures.push(`${inputPath}: path does not exist`);
      continue;
    }

    const files = (await collectFiles(resolvedPath)).filter(isLspSupportedFile).slice(0, GREP_MAX_FILES);
    for (const filePath of files) {
      const result = await runShellCommand(`bun x tsc --noEmit --pretty false ${shellQuote(filePath)}`, workspaceRoot, 30_000, {
        checkCommandPermission: false,
      });
      if (result.exitCode !== 0) {
        const output = `${result.stdout}\n${result.stderr}`.trim();
        diagnostics.push(`${filePath}: ${firstNonEmptyLine(output) ?? `exit ${result.exitCode}`}`);
      }
    }
  }

  const count = diagnostics.length + failures.length;
  const label = severity === "warning" ? "warnings/errors" : "errors";
  const details = [...failures, ...diagnostics].slice(0, 20).join("\n");
  const evidence = `${count} diagnostics (${label})${details ? `\n${details}` : ""}`;
  return doneResult(condition.id, count === 0, evidence);
}

async function collectGrepMatches(workspaceRoot: string, inputPath: string, pattern: string): Promise<GrepMatch[]> {
  const resolvedPath = resolveWorkspacePath(workspaceRoot, inputPath);
  if (!(await pathExists(resolvedPath))) return [];

  const regex = new RegExp(pattern, "u");
  const files = (await collectFiles(resolvedPath)).slice(0, GREP_MAX_FILES);
  const matches: GrepMatch[] = [];

  for (const filePath of files) {
    const content = await Bun.file(filePath).text().catch(() => undefined);
    if (content === undefined) continue;

    const relativePath = relativeDisplayPath(workspaceRoot, filePath);
    const lines = content.split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      regex.lastIndex = 0;
      if (regex.test(line)) {
        matches.push({ path: relativePath, line: index + 1, text: line });
      }
    }
  }

  return matches;
}

async function collectFiles(rootPath: string): Promise<string[]> {
  const stats = await stat(rootPath).catch(() => undefined);
  if (!stats) return [];
  if (stats.isFile()) return [rootPath];
  if (!stats.isDirectory()) return [];

  const files: string[] = [];
  await walkFiles(rootPath, files);
  return files;
}

async function walkFiles(dirPath: string, files: string[]): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      await walkFiles(fullPath, files);
      continue;
    }
    if (entry.isFile()) files.push(fullPath);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  options: EvaluateConditionOptions = {},
): Promise<CommandResult> {
  if (options.checkCommandPermission !== false) {
    const permissionDenied = await commandPermissionDenial(command, cwd, Math.min(timeoutMs, MAX_DONE_COMMAND_TIMEOUT_MS), options);
    if (permissionDenied) return permissionDenied;
  }

  const result = await createProcessRunner().run({
    argv: ["bash", "-c", command],
    cwd,
    env: buildDoneCommandEnv(),
    stdin: null,
    timeoutMs: Math.min(timeoutMs, MAX_DONE_COMMAND_TIMEOUT_MS),
  });

  return {
    stdout: result.kind === "spawn-failure" ? "" : result.output.stdout,
    stderr: result.kind === "spawn-failure" ? result.error.message : result.output.stderr,
    exitCode: processResultExitCode(result),
  };
}

async function commandPermissionDenial(
  command: string,
  cwd: string,
  timeoutMs: number,
  options: EvaluateConditionOptions,
): Promise<CommandResult | undefined> {
  const decision = classifyCommand(command, { workspaceRoot: cwd });
  if (decision.outcome === "allow") return undefined;
  if (decision.outcome === "deny") {
    return commandDeniedResult(decision.reason ?? "Done condition command was denied by bash policy");
  }

  if (!options.confirmPermission) {
    return commandDeniedResult(decision.reason ?? "Done condition command requires permission confirmation");
  }

  const confirmation = await options.confirmPermission({
    toolName: options.toolName ?? "goal_check_done",
    toolCallId: options.toolCallId ?? "goal-check-done-command",
    input: { command, timeoutMs },
    description: "Evaluate a command-bearing Goal Done Condition through bash policy.",
    reason: decision.prompt ?? decision.reason,
    ...(decision.approval ? { approval: decision.approval } : {}),
    ...(decision.display ? { decisionDisplay: decision.display } : {}),
    ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
  }, options.abort);

  if (confirmation === "approve" || confirmation === "approve_once" || confirmation === "approve_always") {
    return undefined;
  }

  return commandDeniedResult(decision.reason ?? `Done condition command confirmation ${confirmation}`);
}

function commandDeniedResult(reason: string): CommandResult {
  return { exitCode: 126, stdout: "", stderr: `Permission denied: ${reason}` };
}

function buildDoneCommandEnv(source: Record<string, string | undefined> = Bun.env): Record<string, string> {
  const env: Record<string, string> = { ARCHCODE_CLI: "1" };
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function processResultExitCode(result: ProcessRunnerResult): number {
  if (result.kind === "success" || result.kind === "nonzero") return result.exitCode;
  if (result.kind === "timeout" || result.kind === "aborted") return result.exitCode ?? 124;
  if (result.kind === "signal") return result.exitCode ?? 128;
  return 127;
}

function doneResult(conditionId: string, passed: boolean, evidence: string): DoneResult {
  return {
    conditionId,
    passed,
    evidence: truncateEvidence(evidence),
    checkedAt: new Date().toISOString(),
  };
}

function formatCommandEvidence(result: CommandResult): string {
  return `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}\nEXIT_CODE: ${result.exitCode}`;
}

function formatGrepEvidence(matches: GrepMatch[], summary: string): string {
  const firstMatch = matches[0];
  if (!firstMatch) return summary;
  return `${summary}\nfirst match: ${firstMatch.path}:${firstMatch.line}: ${firstMatch.text}`;
}

function truncateEvidence(evidence: string): string {
  if (evidence.length <= MAX_EVIDENCE_LENGTH) return evidence;
  return `${evidence.slice(0, MAX_EVIDENCE_LENGTH)}\n[truncated]`;
}

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedPath = resolve(resolvedRoot, inputPath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}/`)) {
    throw new Error(`Done condition path escapes workspace: ${inputPath}`);
  }
  return resolvedPath;
}

function relativeDisplayPath(workspaceRoot: string, filePath: string): string {
  return filePath.startsWith(`${workspaceRoot}/`) ? filePath.slice(workspaceRoot.length + 1) : filePath;
}

function isLspSupportedFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|json|css|html)$/u.test(filePath);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function firstNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/u).find((line) => line.trim().length > 0);
}
