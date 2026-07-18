import { ENV_CLI } from "@archcode/protocol";
import { z } from "zod";
import { defineTool } from "../define-tool";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { createToolErrorResult } from "../errors";
import { createBashPermission } from "../permission";
import { PathValidator } from "../security";
import { createProcessRunner } from "../../process/runner";
import type { ProcessRunnerResult } from "../../process/types";

export const BashInputSchema = z
  .object({
    description: z.string().min(1).describe("One concise sentence explaining the observable purpose, for example `Run the agent-core unit tests`."),
    command: z.string().min(1).describe("Bash command to execute, for example `bun run test:unit`. Use `&&` when later commands require earlier success; use `;` only when they may continue after failure."),
    cwd: z.string().optional().describe("Per-call working directory, absolute or relative to the current Session cwd, for example `packages/agent-core`. It must resolve inside the workspace and defaults to the Session cwd."),
    timeoutMs: z.number().int().positive().optional().describe("Optional wrapper timeout in milliseconds, for example 600000 for ten minutes. The process is killed when it expires; omitting it means no ArchCode wrapper timeout."),
  })
  .strict();

type BashInput = z.infer<typeof BashInputSchema>;

const ENV_ALLOWLIST = ["PATH", "HOME", "SHELL", "TERM", "LANG", "LC_ALL"] as const;

export function buildBashEnv(source: Record<string, string | undefined> = Bun.env): Record<string, string> {
  const env: Record<string, string> = { [ENV_CLI]: "1" };

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

function resolveCwd(executionCwd: string, cwd?: string): string {
  if (!cwd) return new PathValidator(executionCwd).workspaceRealPath;

  const result = new PathValidator(executionCwd).validate(cwd);
  if (!result.ok) {
    throw new Error(`cwd must resolve inside workspace: ${cwd}`);
  }

  return result.resolvedPath;
}

export async function runBashCommand(
  input: BashInput,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const cwd = resolveCwd(ctx.cwd, input.cwd);
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
  description: [
    "Run one foreground `bash -c` process for terminal work such as builds, tests, package managers, Git, or project CLIs. Do not use it to read, write, edit, search, or find files when file_read, file_write, file_edit, grep, or glob can express the operation directly.",
    "",
    "Example: `bash({\"description\":\"Run the agent-core unit tests\",\"command\":\"bun run test:unit\",\"cwd\":\"packages/agent-core\",\"timeoutMs\":600000})`. Put dependent commands in one call with `&&`; use separate calls when their outputs must be interpreted before choosing the next command.",
    "",
    "Each call starts a fresh shell: cwd and environment changes do not persist across calls, stdin is closed, and only the allowlisted environment is inherited. Prefer the cwd argument over a leading `cd` for one working directory. timeoutMs is milliseconds; when omitted, ArchCode adds no wrapper timeout.",
    "",
    "For commits, rebases, branch management, history investigation, or PR preparation, read the git-master Skill first when it is available. Do not commit, amend, push, force-push, or rewrite history unless the user requested that effect. Before a Git write, inspect git_status, both relevant git_diff views, and recent history; preserve unrelated changes and never stage secrets.",
    "",
    "Completed exits return labeled STDOUT, STDERR, and EXIT_CODE. A nonzero exit is a failed result: inspect its stderr and exit code, correct the cause, and re-run only when the correction justifies it. Timeout, abort, signal, and spawn failures return their own typed error results and may not include that triplet.",
  ].join("\n"),
  inputSchema: BashInputSchema,
  traits: { readOnly: false, destructive: true, concurrencySafe: false },
  prepareInput: (raw, ctx) => {
    if (raw && typeof raw === "object" && "cwd" in raw && typeof raw.cwd === "string") {
      resolveCwd(ctx.cwd, raw.cwd);
    }
    return raw;
  },
  permissions: [createBashPermission()],
  execute: async (input: BashInput, ctx: ToolExecutionContext) => {
    return runBashCommand(input, ctx);
  },
});
