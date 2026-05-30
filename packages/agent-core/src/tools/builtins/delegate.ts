import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionContext } from "../types";
import type { StoredMessage } from "../../store/types";
import { SKILL_NAME_REGEX } from "../../skills/schema";
import type { AgentRunHandle } from "../../delegation/types";
import type { SessionRun } from "@specra/protocol";

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

export async function executeDelegate(input: DelegateInput, ctx: ToolExecutionContext) {
  if (ctx.agentFactory === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_DELEGATE_FACTORY_UNAVAILABLE",
      name: "SubAgentError",
      message: "AgentFactory is not available in this execution context",
      details: { ok: false, session_id: "" } satisfies Pick<DelegateErrorOutput, "ok" | "session_id">,
    });
  }

  let handle: AgentRunHandle;
  try {
    handle = await ctx.agentFactory.delegate({
      parentStore: ctx.store,
      parentAgentName: ctx.agentName ?? "orchestrator",
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
    return formatAsyncDelegateOutput({ input, ctx, handle });
  }

  let terminalError: unknown;
  try {
    await handle.result;
  } catch (error) {
    terminalError = error;
  }

  return formatSyncDelegateOutput({ input, ctx, handle, terminalError });
}

interface DelegateOutputOptions {
  readonly input: DelegateInput;
  readonly ctx: ToolExecutionContext;
  readonly handle: AgentRunHandle;
}

interface SyncDelegateOutputOptions extends DelegateOutputOptions {
  readonly terminalError?: unknown;
}

function formatAsyncDelegateOutput(options: DelegateOutputOptions): string {
  const { input, ctx, handle } = options;
  const run = handle.store.getState().runs.at(-1);
  const metadata = formatDelegateMetadata({
    sessionId: handle.sessionId,
    parentSessionId: ctx.store.getState().sessionId,
    agentType: input.agent_type,
    description: input.description,
    status: "running",
    background: true,
    startedAt: run?.startedAt ?? Date.now(),
  });

  return [
    "Sub-agent started.",
    `Agent type: ${input.agent_type}`,
    `Session ID: ${handle.sessionId}`,
    "Status: running",
    `Use background_output(session_id="${handle.sessionId}") to read the result.`,
    "",
    metadata,
  ].join("\n");
}

function formatSyncDelegateOutput(options: SyncDelegateOutputOptions): string {
  const { input, ctx, handle, terminalError } = options;
  const state = handle.store.getState();
  const run = state.runs.at(-1);
  const status = terminalStatus(run, terminalError);
  const resultText = getLastAssistantText(state.messages);
  const metadata = formatDelegateMetadata({
    sessionId: handle.sessionId,
    parentSessionId: ctx.store.getState().sessionId,
    agentType: input.agent_type,
    description: input.description,
    status,
    background: false,
    startedAt: run?.startedAt,
    endedAt: run?.endedAt,
    durationMs: run?.durationMs,
  });

  return [
    `Sub-agent ${formatHeadlineStatus(status)}.`,
    `Agent type: ${input.agent_type}`,
    `Session ID: ${handle.sessionId}`,
    `Status: ${status}`,
    durationLine(run),
    "Result:",
    resultText,
    "",
    metadata,
  ].filter((line): line is string => line !== undefined).join("\n");
}

type DelegateStatus = SessionRun["status"];

interface DelegateMetadataInput {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly agentType: string;
  readonly description?: string;
  readonly status: DelegateStatus;
  readonly background: boolean;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
}

function formatDelegateMetadata(input: DelegateMetadataInput): string {
  const lines = [
    "<delegate_metadata>",
    `session_id: ${yamlScalar(input.sessionId)}`,
    `parent_session_id: ${yamlScalar(input.parentSessionId)}`,
    `agent_type: ${yamlScalar(input.agentType)}`,
    `description: ${yamlScalar(input.description ?? "")}`,
    `status: ${input.status}`,
    `background: ${input.background ? "true" : "false"}`,
    `started_at: ${numberOrEmpty(input.startedAt)}`,
    `ended_at: ${numberOrEmpty(input.endedAt)}`,
    `duration_ms: ${numberOrEmpty(input.durationMs)}`,
    "</delegate_metadata>",
  ];

  return lines.join("\n");
}

function terminalStatus(run: SessionRun | undefined, terminalError: unknown): DelegateStatus {
  if (run !== undefined && run.status !== "running") return run.status;
  if (terminalError === undefined) return "completed";
  const message = terminalError instanceof Error ? terminalError.message : String(terminalError);
  if (/timed out/i.test(message)) return "timed_out";
  if (/aborted/i.test(message)) return "aborted";
  if (/cancelled|canceled/i.test(message)) return "cancelled";
  if (/max steps/i.test(message)) return "max_steps";
  return "failed";
}

function durationLine(run: SessionRun | undefined): string | undefined {
  if (run?.durationMs === undefined) return undefined;
  return `Duration: ${run.durationMs}ms`;
}

function formatHeadlineStatus(status: DelegateStatus): string {
  if (status === "completed") return "completed";
  if (status === "timed_out") return "timed out";
  if (status === "max_steps") return "reached max steps";
  return status;
}

function numberOrEmpty(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function yamlScalar(value: string): string {
  return value.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
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
    `Delegate a task to another agent (e.g. "explore"). Parameters: agent_type (target agent), prompt (the task instructions), skills (skill names to activate, pass [] for none), description (optional short label), title (optional session title), background (true=async, use background_output to read results later). Output: natural language summary + <delegate_metadata> block with session_id and status.`,
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
