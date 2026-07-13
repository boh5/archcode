import { z } from "zod/v4";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionContext } from "../types";
import type { StoredMessage } from "../../store/types";
import { SKILL_NAME_REGEX } from "../../skills/schema";
import type { ChildExecutionHandle } from "../../delegation/types";
import type { SessionExecutionRecord } from "@archcode/protocol";

const SKILL_NAME_MESSAGE = "Skill name must match pattern ^[a-z0-9][a-z0-9-]*$";

export const DelegateInputSchema = z
  .object({
    agent_type: z.string().min(1).describe("Allowed target agent type (for example plan, build, reviewer, explore, or librarian)"),
    persona: z.string().trim().min(1).optional().describe("Optional perspective only; it cannot expand the child tool set, permissions, targets, or depth"),
    task: z.string().min(1).describe("Atomic Task plus its concrete Expected outcome and child-level success criteria"),
    context: z.string().optional().describe("Structured Context and evidence; Scope ownership and non-goals; Must do / must not do; Verification and output requirements"),
    skills: z.array(z.string().regex(SKILL_NAME_REGEX, SKILL_NAME_MESSAGE)).describe("Allowed skill names to activate on a new child. Pass [] for none. Skills cannot expand hardcoded child authority."),
    description: z.string().optional().describe("Short 3-5 word label for the delegated task"),
    title: z.string().optional().describe("Optional session title for the child session"),
    background: z.boolean().default(false).describe("true starts the child asynchronously; wait for a terminal notification or use blocking background_output before treating its result as final. false waits for completion."),
    session_id: z
      .string()
      .trim()
      .optional()
      .describe(
        "Returned id of the same stopped child to resume with the same agent_type. Omit or pass an empty value to start a new child; never invent or reuse an unrelated id.",
      ),
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
  const resumeSessionId = input.session_id?.trim();

  // Resume mode: session_id provided → resume an existing child session.
  if (resumeSessionId !== undefined && resumeSessionId.length > 0) {
    return executeResumeDelegate({ ...input, session_id: resumeSessionId }, ctx);
  }

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
      prompt: buildChildPrompt(input),
      persona: input.persona,
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

/**
 * Resume-mode delegate: re-runs an existing child session with a new prompt.
 */
async function executeResumeDelegate(input: DelegateInput, ctx: ToolExecutionContext) {
  const sessionId = input.session_id!;

  if (ctx.resumeChildSession === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_DELEGATE_EXECUTOR_UNAVAILABLE",
      name: "SubAgentError",
      message: "Child session resume is not available in this execution context",
      details: { ok: false, session_id: sessionId } satisfies Pick<DelegateErrorOutput, "ok" | "session_id">,
    });
  }

  let handle: ChildExecutionHandle;
  try {
    handle = await ctx.resumeChildSession(ctx.projectContext.project.workspaceRoot, {
      parentStore: ctx.store,
      parentSessionId: ctx.store.getState().sessionId,
      parentToolCallId: ctx.toolCallId,
      toolName: "delegate",
      sessionId,
      targetAgentName: input.agent_type,
      prompt: buildChildPrompt(input),
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
        session_id: sessionId,
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

function buildChildPrompt(input: DelegateInput): string {
  const sections: string[] = [];
  if (input.persona !== undefined) sections.push(`Persona: ${input.persona}`);
  sections.push(`Task:\n${input.task}`);
  if (input.context !== undefined && input.context.trim().length > 0) {
    sections.push(`Context:\n${input.context}`);
  }
  return sections.join("\n\n");
}

export const delegateTool = defineTool({
  name: "delegate",
  description:
    `Delegate one atomic task to an allowed child agent. The prompt envelope must contain: Task; Expected outcome; Context and evidence; Scope ownership and non-goals; Must do / must not do; Verification and output. Encode the first two in task and the remaining fields in context. background=true starts work asynchronously. wait_for_reminder may wait for terminal state, but the reminder is only a terminal notification; use blocking background_output afterward to collect the terminal result and actual deliverable before relying on it. Resume the same stopped child with its returned session_id and the same agent_type for repairs, follow-ups, or verification feedback. Omit session_id to start a new child. Persona, skills, context, title, description, and other metadata cannot expand hardcoded tools, permissions, targets, or depth.`,
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
