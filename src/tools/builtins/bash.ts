import { z } from "zod";
import { defineTool } from "../define-tool";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { createToolErrorResult } from "../errors";
import { createBashGuard } from "../security/bash-classifier";
import { PathValidator } from "../security/path-validator";

export const BashInputSchema = z
  .object({
    command: z.string().min(1),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

type BashInput = z.infer<typeof BashInputSchema>;

const ENV_ALLOWLIST = ["PATH", "HOME", "SHELL", "TERM", "LANG", "LC_ALL"] as const;

export function buildBashEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
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

function safeKill(proc: { kill: () => void }): void {
  try {
    proc.kill();
  } catch {
    // Process may already have exited.
  }
}

export async function runBashCommand(
  input: BashInput,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const cwd = resolveCwd(ctx.workspaceRoot, input.cwd);
  const env = buildBashEnv();
  let timedOut = false;
  let aborted = ctx.abort.aborted;

  const proc = Bun.spawn(["bash", "-c", input.command], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const killForAbort = () => {
    aborted = true;
    safeKill(proc);
  };

  let timeout: Timer | undefined;
  if (input.timeoutMs !== undefined) {
    timeout = setTimeout(() => {
      timedOut = true;
      safeKill(proc);
    }, input.timeoutMs);
  }

  if (ctx.abort.aborted) {
    killForAbort();
  } else {
    ctx.abort.addEventListener("abort", killForAbort, { once: true });
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (timedOut) {
      return createToolErrorResult({
        kind: "bash-timeout",
        message: `Command timed out after ${input.timeoutMs}ms`,
        meta: { timedOut: true, timeoutMs: input.timeoutMs },
      });
    }

    if (aborted) {
      return createToolErrorResult({
        kind: "bash-aborted",
        message: "Command was aborted",
        meta: { aborted: true },
      });
    }

    if (exitCode !== 0) {
      return createToolErrorResult({
        kind: "bash-nonzero",
        message: formatBashOutput(stdout, stderr, exitCode),
        meta: { exitCode },
      });
    }

    return {
      output: formatBashOutput(stdout, stderr, exitCode),
      isError: false,
      meta: { exitCode },
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    ctx.abort.removeEventListener("abort", killForAbort);
  }
}

export const bashTool = defineTool({
  name: "bash",
  description:
    "Runs a non-persistent bash command inside the workspace with guarded permissions, minimal environment, closed stdin, and optional timeout.",
  inputSchema: BashInputSchema,
  traits: { readOnly: false, destructive: true, concurrencySafe: false },
  prepareInput: (raw, ctx) => {
    if (raw && typeof raw === "object" && "cwd" in raw && typeof raw.cwd === "string") {
      resolveCwd(ctx.workspaceRoot, raw.cwd);
    }
    return raw;
  },
  guards: [createBashGuard(process.cwd())],
  execute: async (input: BashInput, ctx: ToolExecutionContext) => {
    return runBashCommand(input, ctx);
  },
});
