import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionContext } from "../types";
import type { StoredMessage } from "../../store/types";
import { SKILL_NAME_REGEX } from "../../skills/schema";
import type { ChildExecutionHandle } from "../../delegation/types";
import type { SessionExecutionRecord } from "@specra/protocol";

const SKILL_NAME_MESSAGE = "Skill name must match pattern ^[a-z0-9][a-z0-9-]*$";

export const DelegateInputSchema = z
  .object({
    agent_type: z.string().min(1),
    prompt: z.string(),
    skills: z.array(z.string().regex(SKILL_NAME_REGEX, SKILL_NAME_MESSAGE)),
    description: z.string().optional(),
    title: z.string().optional(),
    background: z.boolean().default(false),
  })
  .strict();

export type DelegateInput = z.infer<typeof DelegateInputSchema>;

export interface DelegateErrorOutput {
  ok: false;
  session_id: string;
  error: {
    name: string;
    message: string;
  };
}

interface ChildExecutionOutcome {
  readonly status: DelegateStatus;
  readonly resultText: string;
  readonly terminalError?: unknown;
}

export async function executeDelegate(input: DelegateInput, ctx: ToolExecutionContext) {
  if (ctx.startChildExecution === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_DELEGATE_EXECUTOR_UNAVAILABLE",
      name: "SubAgentError",
      message: "Child execution is not available in this execution context",
      details: { ok: false, session_id: "" } satisfies Pick<DelegateErrorOutput, "ok" | "session_id">,
    });
  }

  let handle: ChildExecutionHandle;
  try {
    handle = await ctx.startChildExecution({
      parentStore: ctx.store,
      parentSessionId: ctx.store.getState().sessionId,
      parentToolCallId: ctx.toolCallId,
      toolName: "delegate",
      targetAgentName: input.agent_type,
      prompt: input.prompt,
      skills: input.skills,
      title: input.title ?? input.description,
      description: input.description,
      background: input.background ?? false,
      currentDepth: ctx.currentDepth ?? 0,
      parentAbort: ctx.abort,
    });
  } catch (error) {
    const safeError = error instanceof Error ? error : new Error(String(error));
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_DELEGATE_FAILED",
      message: safeError.message,
      name: safeError.name,
      error: safeError,
      details: {
        ok: false,
        session_id: "",
        error: { name: safeError.name, message: safeError.message },
      } satisfies DelegateErrorOutput,
    });
  }

  if (input.background ?? false) {
    return formatAsyncDelegateOutput({ input, handle });
  }

  const outcome = await waitForChildOutcome(handle);
  return formatSyncDelegateOutput({ input, handle, outcome });
}

interface DelegateOutputOptions {
  readonly input: DelegateInput;
  readonly handle: ChildExecutionHandle;
}

interface SyncDelegateOutputOptions extends DelegateOutputOptions {
  readonly outcome: ChildExecutionOutcome;
}

function formatAsyncDelegateOutput(options: DelegateOutputOptions): string {
  const { input, handle } = options;

  return [
    "Sub-agent started.",
    `Agent type: ${input.agent_type}`,
    `Session ID: ${handle.sessionId}`,
    "Status: running",
    `Use background_output(session_id="${handle.sessionId}") to read the result.`,
  ].join("\n");
}

function formatSyncDelegateOutput(options: SyncDelegateOutputOptions): string {
  const { input, handle, outcome } = options;
  const state = handle.store.getState();
  const run = state.executions.at(-1);

  return [
    `Sub-agent result: ${formatHeadlineStatus(outcome.status)}.`,
    `Agent type: ${input.agent_type}`,
    `Session ID: ${handle.sessionId}`,
    `Status: ${outcome.status}`,
    durationLine(run),
    errorLine(outcome.terminalError, run),
    "Result:",
    outcome.resultText,
  ].filter((line): line is string => line !== undefined).join("\n");
}

type DelegateStatus = SessionExecutionRecord["status"];

async function waitForChildOutcome(handle: ChildExecutionHandle): Promise<ChildExecutionOutcome> {
  try {
    const result = await handle.result;
    const run = handle.store.getState().executions.at(-1);
    return {
      status: terminalStatus(run, undefined),
      resultText: result.text || getLastAssistantText(handle.store.getState().messages),
    };
  } catch (error) {
    const run = handle.store.getState().executions.at(-1);
    return {
      status: terminalStatus(run, error),
      resultText: getLastAssistantText(handle.store.getState().messages),
      terminalError: error,
    };
  }
}

function terminalStatus(run: SessionExecutionRecord | undefined, terminalError: unknown): DelegateStatus {
  if (run !== undefined && run.status !== "running") return run.status;
  if (terminalError === undefined) return "completed";
  const message = terminalError instanceof Error ? terminalError.message : String(terminalError);
  if (/timed out/i.test(message)) return "timed_out";
  if (/aborted/i.test(message)) return "aborted";
  if (/cancelled|canceled/i.test(message)) return "cancelled";
  if (/max steps/i.test(message)) return "max_steps";
  return "failed";
}

function durationLine(run: SessionExecutionRecord | undefined): string | undefined {
  if (run?.durationMs === undefined) return undefined;
  return `Duration: ${run.durationMs}ms`;
}

function errorLine(error: unknown, run: SessionExecutionRecord | undefined): string | undefined {
  if (run?.error !== undefined) return `Error: ${run.error}`;
  if (error === undefined) return undefined;
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

function formatHeadlineStatus(status: DelegateStatus): string {
  if (status === "completed") return "completed";
  if (status === "timed_out") return "timed out";
  if (status === "max_steps") return "reached max steps";
  return status;
}

export function getLastAssistantText(messages: readonly StoredMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text.length > 0) return text;
  }
  return "";
}

export const delegateTool = defineTool({
  name: "delegate",
  description:
    `Delegate a task to another agent (e.g. "explore"). Parameters: agent_type (target agent), prompt (the task instructions), skills (skill names to activate, pass [] for none), description (optional short label), title (optional session title), background (true=async, use background_output to read results later). Output: plain text summary with the child session id and status.`,
  inputSchema: DelegateInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  execute: async (input, ctx) => executeDelegate(input, ctx),
});

export function missingChildSessionResult(sessionId: string) {
  return createToolErrorResult({
    kind: "execution",
    code: "TOOL_UNKNOWN_CHILD_SESSION",
    message: `Unknown child session_id: ${sessionId}`,
  });
}
