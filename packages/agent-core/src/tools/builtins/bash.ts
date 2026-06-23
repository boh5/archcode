import { z } from "zod";
import { defineTool } from "../define-tool";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { createToolErrorResult } from "../errors";
import { createBashPermission, createProtectedSpecraPermission } from "../permission";
import { PathValidator } from "../security";
import { createProcessRunner } from "../../process/runner";
import type { ProcessRunnerResult } from "../../process/types";

export const BashInputSchema = z
  .object({
    description: z.string().min(1).describe("Brief summary of what the command does"),
    command: z.string().min(1).describe("The bash command(s) to execute. Can be chained with && or ;"),
    cwd: z.string().optional().describe("Working directory for the command (absolute or workspace-relative). Defaults to workspace root."),
    timeoutMs: z.number().int().positive().optional().describe("Command timeout in milliseconds. Command is killed if it exceeds this."),
  })
  .strict();

type BashInput = z.infer<typeof BashInputSchema>;

const ENV_ALLOWLIST = ["PATH", "HOME", "SHELL", "TERM", "LANG", "LC_ALL"] as const;

export function buildBashEnv(source: Record<string, string | undefined> = Bun.env): Record<string, string> {
  const env: Record<string, string> = { SPECRA_CLI: "1" };

  for (const key of ENV_ALLOWLIST) {
    if (key.endsWith("_TOKEN") || key.endsWith("_KEY")) continue;
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }

  return env;
}

export function formatBashOutput(stdout: string, stderr: string, exitCode: number): string {
  return `STDOUT:\n${stdout}\nSTDERR:\n${stderr}\nEXIT_CODE: ${exitCode}`;
}

function resolveCwd(workspaceRoot: string, cwd?: string): string {
  if (!cwd) return new PathValidator(workspaceRoot).workspaceRealPath;

  const result = new PathValidator(workspaceRoot).validate(cwd);
  if (!result.ok) {
    throw new Error(`cwd must resolve inside workspace: ${cwd}`);
  }

  return result.resolvedPath;
}

export async function runBashCommand(
  input: BashInput,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const cwd = resolveCwd(ctx.workspaceRoot, input.cwd);
  const env = buildBashEnv();
  const result = await createProcessRunner().run({
    argv: ["bash", "-c", input.command],
    cwd,
    env,
    stdin: null,
    timeoutMs: input.timeoutMs,
    signal: ctx.abort,
  });

  return formatProcessRunnerResult(result, input.timeoutMs);
}

function formatProcessRunnerResult(
  result: ProcessRunnerResult,
  timeoutMs: number | undefined,
): ToolExecutionResult {
  switch (result.kind) {
    case "success":
      return {
        output: formatBashOutput(result.output.stdout, result.output.stderr, result.exitCode),
        isError: false,
        meta: { exitCode: result.exitCode },
      };
    case "nonzero":
      return createToolErrorResult({
        kind: "bash-nonzero",
        message: formatBashOutput(result.output.stdout, result.output.stderr, result.exitCode),
        meta: { exitCode: result.exitCode },
      });
    case "timeout":
      return createToolErrorResult({
        kind: "bash-timeout",
        message: `Command timed out after ${result.timeoutMs}ms`,
        meta: { timedOut: true, timeoutMs: result.timeoutMs },
      });
    case "aborted":
      return createToolErrorResult({
        kind: "bash-aborted",
        message: "Command was aborted",
        meta: { aborted: true },
      });
    case "signal":
      return createToolErrorResult({
        kind: "bash-aborted",
        message: "Command was aborted",
        meta: { aborted: true, signal: result.signal, exitCode: result.exitCode },
      });
    case "spawn-failure":
      return createToolErrorResult({
        kind: "execution",
        message: result.error.message,
        name: result.error.name,
        details: result.error,
        meta: { argv: result.argv, cwd: result.cwd, timeoutMs },
      });
  }
}

export const bashTool = defineTool({
  name: "bash",
  description:
    "Executes a non-persistent bash command inside the workspace with guarded permissions, minimal environment, closed stdin, and optional timeout.",
  inputSchema: BashInputSchema,
  traits: { readOnly: false, destructive: true, concurrencySafe: false },
  prepareInput: (raw, ctx) => {
    if (raw && typeof raw === "object" && "cwd" in raw && typeof raw.cwd === "string") {
      resolveCwd(ctx.workspaceRoot, raw.cwd);
    }
    return raw;
  },
  permissions: [createProtectedSpecraPermission(), createBashPermission()],
  execute: async (input: BashInput, ctx: ToolExecutionContext) => {
    return runBashCommand(input, ctx);
  },
});
