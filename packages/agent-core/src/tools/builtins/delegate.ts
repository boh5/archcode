import { z } from "zod/v4";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type { RawToolResult, ToolExecutionContext } from "../types";
import type { StoredMessage } from "../../store/types";
import { SKILL_NAME_REGEX } from "../../skills/schema";
import type { ChildExecutionHandle } from "../../delegation/types";
import type { SessionExecutionRecord } from "@archcode/protocol";

const SKILL_NAME_MESSAGE = "Skill name must match pattern ^[a-z0-9][a-z0-9-]*$";

export const DelegateInputSchema = z
  .object({
    agent_type: z.string().min(1).describe("Allowed target agent type for the current parent. Engineer roles include plan for design, build for an owned code change, reviewer for independent verification, explore for local source investigation, and librarian for external evidence; other parents may allow only a subset."),
    persona: z.string().trim().min(1).optional().describe("Optional perspective only; it cannot expand the child tool set, permissions, targets, or depth"),
    task: z.string().min(1).describe("One atomic Task stated as an autonomous instruction, with the concrete expected outcome and child-level success criteria. Say explicitly whether to research, plan, edit, or review."),
    context: z.string().optional().describe("All context the fresh child needs: current evidence and starting files; scope ownership and non-goals; must do / must not do; verification commands; and required output format."),
    skills: z.array(z.string().regex(SKILL_NAME_REGEX, SKILL_NAME_MESSAGE)).describe("Allowed Skill names to activate on the new child. Pass [] for none. Skills cannot expand hardcoded child authority. If a Skill is rejected, the error's details.allowed_skills contains the exact names allowed for that target Agent."),
    description: z.string().optional().describe("Optional 3-5 word display label for the delegated task, for example `Trace request path`"),
    title: z.string().trim().min(1).describe("Required parent-supplied title for the new child session"),
    background: z.boolean().default(false).describe("true starts the child asynchronously; wait for a terminal notification or use blocking background_output before treating its result as final. false waits for completion and is the default."),
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
  target_agent?: string;
  rejected_skill?: string;
  allowed_skills?: readonly string[];
}

export interface ChildExecutionOutcome {
  readonly status: DelegateStatus;
  readonly resultText: string;
  readonly terminalError?: unknown;
}

export async function executeDelegate(input: DelegateInput, ctx: ToolExecutionContext): Promise<RawToolResult> {
  if (ctx.startChildExecution === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_DELEGATE_EXECUTOR_UNAVAILABLE",
      name: "SubAgentError",
      message: "Child execution is not available in this execution context",
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
      title: input.title,
      description: input.description,
      background: input.background ?? false,
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
    });
  }

  if (input.background ?? false) {
    return createTextToolResult(formatAsyncChildOutput(handle));
  }

  const outcome = await waitForChildOutcome(handle);
  return createTextToolResult(formatSyncChildOutput(handle, outcome));
}

export function formatAsyncChildOutput(handle: ChildExecutionHandle): string {
  return [
    "Sub-agent started.",
    `Agent type: ${handle.store.getState().agentName}`,
    `Session ID: ${handle.sessionId}`,
    "Status: running",
    `Use background_output(session_id="${handle.sessionId}") to read the result.`,
  ].join("\n");
}

export function formatSyncChildOutput(handle: ChildExecutionHandle, outcome: ChildExecutionOutcome): string {
  const state = handle.store.getState();
  const run = state.executions.at(-1);

  return [
    `Sub-agent result: ${formatHeadlineStatus(outcome.status)}.`,
    `Agent type: ${state.agentName}`,
    `Session ID: ${handle.sessionId}`,
    `Status: ${outcome.status}`,
    durationLine(run),
    errorLine(outcome.terminalError, run),
    "Result:",
    outcome.resultText,
  ].filter((line): line is string => line !== undefined).join("\n");
}

type DelegateStatus = SessionExecutionRecord["status"];

export async function waitForChildOutcome(handle: ChildExecutionHandle): Promise<ChildExecutionOutcome> {
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
  description: [
    "Create a new direct child Session for one concrete, self-contained task.",
    "",
    "Use it for an independently owned implementation, plan, review, or research question: Plan designs implementation; Build owns a disjoint code change; Reviewer independently verifies; Explore investigates local source read-only; Librarian researches external documentation or source. The current parent may allow only a subset. Do not delegate a known single-file read, an exact symbol search, a small localized change the current role can perform directly, or work with no fitting target Agent.",
    "",
    "Every new child starts with fresh context and does not inherit the parent's conversation history. The brief must therefore stand alone: state whether to research, plan, edit, or review; give the expected outcome and success criteria; pass starting evidence/files; define owned scope and non-goals; include must-do/must-not-do constraints, verification, and output format. Example: `delegate({\"agent_type\":\"explore\",\"title\":\"Trace request path\",\"description\":\"Trace request path\",\"task\":\"Trace request validation from the route to the owning service and return the exact files and symbols. Research only; do not edit.\",\"context\":\"Start at apps/server/src/routes. Exclude UI code. Return an ordered call path with file references and unresolved gaps.\",\"skills\":[],\"background\":true})`.",
    "",
    "Do not duplicate delegated work. For several independent background children, launch them before waiting so their executions can overlap, and never give children overlapping file ownership.",
    "",
    "background=false is the default: it waits and returns terminal status plus the result in this call. background=true returns a Session ID immediately and later emits a terminal reminder. The background workflow is `delegate(..., background=true)` -> one `wait_for_reminder({\"session_ids\":[\"<session-id>\"],\"condition\":\"all\",\"timeout_ms\":1800000})` -> `background_output({\"session_id\":\"<session-id>\",\"block\":true,\"timeout_ms\":1800000})` for the actual deliverable. Do not poll between those steps.",
    "",
    "Use resume_session, not a new delegate, to continue a stopped direct child. Persona, Skills, title, context, and other metadata cannot expand hardcoded targets, tools, permissions, or depth.",
  ].join("\n"),
  inputSchema: DelegateInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
  execute: async (input, ctx) => executeDelegate(input, ctx),
});
