import { z } from "zod";
import type { StoreApi } from "zustand";
import type { SessionStoreState, StoredMessage, StoredPart, ToolPart } from "../../store/types";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { getLastAssistantText } from "./delegate";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MESSAGE_LIMIT = 20;
const MAX_MESSAGE_LIMIT = 100;
const TOOL_RESULT_PART_CAP = 2_000;
const REASONING_PART_CAP = 1_000;
const GLOBAL_OUTPUT_CAP = 8_000;

export const BackgroundOutputInputSchema = z
  .object({
    session_id: z.string().describe("Child session id — must be a direct child of the current session"),
    block: z.boolean().default(false).describe("Wait for the child to finish before returning. Default false."),
    timeout_ms: z.number().int().min(0).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS).describe("Max wait time in ms when blocking. Default 60000."),
    full_session: z.boolean().default(false).describe("Return full message history instead of latest output only. Default false."),
    message_limit: z.number().int().min(1).max(MAX_MESSAGE_LIMIT).default(DEFAULT_MESSAGE_LIMIT).describe("Max messages to return in full_session mode. Default 20."),
    since_message_id: z.string().optional().describe("Exclusive cursor — return only messages after this id (for incremental reads)"),
    include_tool_results: z.boolean().default(false).describe("Include tool call results in output (hidden by default)"),
    include_reasoning: z.boolean().default(false).describe("Include assistant reasoning content in output (hidden by default)"),
  })
  .strict();

export type BackgroundOutputInput = z.infer<typeof BackgroundOutputInputSchema>;

export async function executeBackgroundOutput(
  input: BackgroundOutputInput,
  ctx: ToolExecutionContext,
): Promise<string | ToolExecutionResult> {
  if (input.session_id === ctx.store.getState().sessionId) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_INVALID_BACKGROUND_SESSION",
      message: "background_output cannot read the current session; provide a delegated session_id.",
    });
  }

  let childStore: StoreApi<SessionStoreState> | undefined;
  try {
    childStore = await getChildStore(input, ctx);
  } catch (err) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_CHILD_SESSION_LOAD_FAILED",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (childStore === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_CHILD_SESSION_NOT_FOUND",
      message: `Child session store not found: ${input.session_id}`,
    });
  }

  const waitResult = input.block && childStore.getState().isRunning
    ? await waitForChildToStop(childStore, input.timeout_ms, ctx.abort)
    : "not_waited";

  const output = input.full_session
    ? renderFullSession(input, childStore.getState(), waitResult)
    : renderLatest(input.session_id, childStore.getState(), waitResult);

  return truncateOutput(output);
}

async function getChildStore(
  input: BackgroundOutputInput,
  ctx: ToolExecutionContext,
): Promise<StoreApi<SessionStoreState> | undefined> {
  const liveStore = ctx.storeManager.get(input.session_id, ctx.workspaceRoot);
  if (liveStore !== undefined) return liveStore;

  try {
    return await ctx.storeManager.getOrLoad(input.session_id, ctx.workspaceRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load child session ${input.session_id}: ${msg}`);
  }
}

type WaitResult = "not_waited" | "stopped" | "timed_out" | "aborted";

function waitForChildToStop(
  childStore: StoreApi<SessionStoreState>,
  timeoutMs: number,
  abortSignal: AbortSignal,
): Promise<WaitResult> {
  if (!childStore.getState().isRunning) return Promise.resolve("stopped");
  if (abortSignal.aborted) return Promise.resolve("aborted");

  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      unsubscribe();
      abortSignal.removeEventListener("abort", onAbort);
    };

    const settle = (result: WaitResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onAbort = () => settle("aborted");
    const unsubscribe = childStore.subscribe((state) => {
      if (!state.isRunning) settle("stopped");
    });

    abortSignal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => settle("timed_out"), timeoutMs);

    if (!childStore.getState().isRunning) settle("stopped");
  });
}

function renderLatest(sessionId: string, state: SessionStoreState, waitResult: WaitResult): string {
  const lines = [
    `# Background session ${sessionId}`,
    "",
    `Status: ${sessionStatus(state)}`,
    "",
    "## Latest assistant output",
  ];

  const text = getLastAssistantText(state.messages);
  lines.push(text.length > 0 ? text : "_No assistant output yet._");

  const note = statusNote(state, waitResult);
  if (note.length > 0) {
    lines.push("", note);
  }

  return lines.join("\n");
}

function renderFullSession(
  input: BackgroundOutputInput,
  state: SessionStoreState,
  waitResult: WaitResult,
): string {
  const messages = selectMessages(state.messages, input.since_message_id, input.message_limit);
  const lines = [
    `# Background session ${state.sessionId}`,
    "",
    `Status: ${sessionStatus(state)}`,
    `Messages: ${messages.length}`,
  ];

  const note = statusNote(state, waitResult);
  if (note.length > 0) lines.push("", note);

  if (messages.length === 0) {
    lines.push("", "_No messages matched the requested cursor/limit._");
    return lines.join("\n");
  }

  for (const message of messages) {
    lines.push("", `## ${message.role} ${message.id}`);
    const renderedParts = message.parts
      .map((part) => renderPart(part, input))
      .filter((part) => part.length > 0);
    lines.push(renderedParts.length > 0 ? renderedParts.join("\n\n") : "_No visible parts._");
  }

  return lines.join("\n");
}

function selectMessages(
  messages: readonly StoredMessage[],
  sinceMessageId: string | undefined,
  limit: number,
): readonly StoredMessage[] {
  const startIndex = sinceMessageId === undefined
    ? 0
    : Math.max(messages.findIndex((message) => message.id === sinceMessageId) + 1, 0);

  return messages.slice(startIndex, startIndex + limit);
}

function renderPart(part: StoredPart, input: BackgroundOutputInput): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "reasoning":
      return input.include_reasoning
        ? `### Reasoning\n${truncatePart(part.text, REASONING_PART_CAP)}`
        : "";
    case "tool":
      return renderToolPart(part, input.include_tool_results);
    case "compaction":
      return `### Compaction\n${part.summary}`;
    case "system-notice":
      return `### System notice\n${part.notice}`;
    case "recovery-notice":
      return `### Recovery notice\n${part.message}`;
  }
}

function renderToolPart(part: ToolPart, includeToolResults: boolean): string {
  const lines = [`- Tool call: ${part.toolName} [${part.state}]`];

  if (!includeToolResults) return lines.join("\n");

  if (part.state === "completed") {
    lines.push("", "```text", truncatePart(part.output, TOOL_RESULT_PART_CAP), "```");
  } else if (part.state === "error") {
    lines.push("", "```text", truncatePart(part.errorMessage, TOOL_RESULT_PART_CAP), "```");
  }

  return lines.join("\n");
}

function sessionStatus(state: SessionStoreState): string {
  if (state.isRunning) return "running";
  return state.executions.at(-1)?.status ?? "idle";
}

function statusNote(state: SessionStoreState, waitResult: WaitResult): string {
  if (waitResult === "timed_out") {
    return "Timed out waiting for the sub-agent. Current output is shown above.";
  }

  if (waitResult === "aborted") {
    return "Stopped waiting because the parent run was aborted. Current output is shown above.";
  }

  if (state.isRunning) {
    return "Sub-agent is still running. Use block=true to wait, or wait_for_reminder for completion notification.";
  }

  return "";
}

function truncatePart(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n[part truncated]`;
}

function truncateOutput(value: string): string {
  if (value.length <= GLOBAL_OUTPUT_CAP) return value;
  return `${value.slice(0, GLOBAL_OUTPUT_CAP)}\n\n[output truncated]`;
}

export const backgroundOutputTool = defineTool({
  name: "background_output",
  description:
    `Read output from a direct child background sub-agent session.`,
  inputSchema: BackgroundOutputInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  execute: executeBackgroundOutput,
});
