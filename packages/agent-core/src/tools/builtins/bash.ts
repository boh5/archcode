import { ENV_CLI } from "@archcode/protocol";
import { z } from "zod";
import { defineTool } from "../define-tool";
import type { RawToolResult, ToolExecutionContext } from "../types";
import { createToolErrorResult } from "../errors";
import { createBashPermission } from "../permission";
import { PathValidator } from "../security";
import { createProcessRunner } from "../../process/runner";
import type { ProcessOutputSink, ProcessOutputStream, ProcessRunnerResult } from "../../process/types";

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
): Promise<RawToolResult> {
  const cwd = resolveCwd(ctx.cwd, input.cwd);
  const env = buildBashEnv();
  const capture = ctx.outputCapture;
  if (capture === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_OUTPUT_UNAVAILABLE",
      message: "bash requires a Registry-owned output capture",
    });
  }
  const adapter = new BashCanonicalOutputSink(capture.write.bind(capture));
  const result = await createProcessRunner().run({
    argv: ["bash", "-c", input.command],
    cwd,
    env,
    stdin: null,
    timeoutMs: input.timeoutMs,
    signal: ctx.abort,
    outputSink: adapter,
  });

  if (result.kind !== "spawn-failure") {
    await adapter.finish(result.kind === "success" || result.kind === "nonzero" ? result.exitCode : result.exitCode ?? null);
  }
  return formatProcessRunnerResult(result);
}

function formatProcessRunnerResult(
  result: ProcessRunnerResult,
): RawToolResult {
  switch (result.kind) {
    case "success":
      return {
        isError: false,
        draft: { kind: "capture" },
        details: { process: processDetails(result, false, false) },
      };
    case "nonzero":
      return captureError("bash-nonzero", "TOOL_BASH_NONZERO_EXIT", "Command exited nonzero", processDetails(result, false, false));
    case "timeout":
      return captureError("bash-timeout", "TOOL_BASH_TIMEOUT", `Command timed out after ${result.timeoutMs}ms`, processDetails(result, true, false));
    case "aborted":
      return captureError("bash-aborted", "TOOL_BASH_ABORTED", "Command was aborted", processDetails(result, false, true));
    case "signal":
      return captureError("bash-aborted", "TOOL_BASH_ABORTED", "Command was terminated by a signal", processDetails(result, false, true));
    case "spawn-failure":
      return createToolErrorResult({
        kind: "execution",
        message: result.error.message,
        name: result.error.name,
      });
  }
}

function processDetails(
  result: Exclude<ProcessRunnerResult, { kind: "spawn-failure" }>,
  timedOut: boolean,
  aborted: boolean,
) {
  return {
    exitCode: result.exitCode ?? null,
    signal: result.kind === "signal" ? String(result.signal) : null,
    timedOut,
    aborted,
    durationMs: result.durationMs,
  };
}

function captureError(
  kind: Parameters<typeof createToolErrorResult>[0]["kind"],
  code: string,
  message: string,
  process: ReturnType<typeof processDetails>,
): RawToolResult {
  const error = createToolErrorResult({ kind, code, message });
  return {
    ...error,
    draft: { kind: "capture" },
    details: { ...error.details, process },
  };
}

class BashCanonicalOutputSink implements ProcessOutputSink {
  #lastStream: ProcessOutputStream | undefined;
  #seenStreams = new Set<ProcessOutputStream>();
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly writeCapture: (chunk: string | Uint8Array) => Promise<"accepted" | "discarded">) {}

  write(stream: ProcessOutputStream, chunk: Uint8Array): Promise<void> {
    this.#tail = this.#tail.then(async () => {
      const writes: Array<Promise<"accepted" | "discarded">> = [];
      if (this.#lastStream !== stream) {
        writes.push(this.writeCapture(`${this.#lastStream === undefined ? "" : "\n"}${stream.toUpperCase()}:\n`));
        this.#lastStream = stream;
      }
      this.#seenStreams.add(stream);
      writes.push(this.writeCapture(chunk));
      for (const write of writes) await write;
    });
    return this.#tail;
  }

  discard(stream: ProcessOutputStream, chunk: Uint8Array): void {
    if (this.#lastStream !== stream) {
      void this.writeCapture(`${this.#lastStream === undefined ? "" : "\n"}${stream.toUpperCase()}:\n`).catch(() => undefined);
      this.#lastStream = stream;
    }
    this.#seenStreams.add(stream);
    void this.writeCapture(chunk).catch(() => undefined);
  }

  async finish(exitCode: number | null): Promise<void> {
    await this.#tail;
    for (const stream of ["stdout", "stderr"] as const) {
      if (!this.#seenStreams.has(stream)) {
        await this.writeCapture(`${this.#lastStream === undefined ? "" : "\n"}${stream.toUpperCase()}:\n`);
        this.#lastStream = stream;
      }
    }
    await this.writeCapture(`\nEXIT_CODE: ${exitCode === null ? "unknown" : exitCode}\n`);
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
  outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
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
