import { z } from "zod";
import type { ChildResultReceipt, JsonObject, ToolResultDetails } from "@archcode/protocol";
import type { StoreApi } from "zustand";
import type { SessionStoreState, StoredMessage, StoredPart, ToolPart } from "../../store/types";
import { projectGoalReviewReceipt } from "../../goals/review-schema";
import { sliceUtf8Head, utf8ByteLength } from "../../tool-output/utf8";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createSourceToolResult } from "../results";
import type { RawToolResult, ToolExecutionContext } from "../types";
import { SOURCE_PAGE_MAX_BYTES, SOURCE_PAGE_MAX_LINES } from "./source-page";

const DEFAULT_TIMEOUT_MS = 1_800_000;
const MAX_TIMEOUT_MS = 1_800_000;

const BackgroundOutputCursorSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("latest"),
    message_id: z.string().min(1),
    unit_index: z.number().int().nonnegative().safe(),
    text_offset: z.number().int().nonnegative().safe(),
  }),
  z.strictObject({
    mode: z.literal("full_session"),
    message_id: z.string().min(1),
    unit_index: z.number().int().nonnegative().safe(),
    text_offset: z.number().int().nonnegative().safe(),
  }),
]);

export const BackgroundOutputInputSchema = z
  .object({
    session_id: z.string().describe("Persisted Session ID copied from delegate, resume_session, a terminal reminder, or a prior child result; must not be the current Session ID."),
    block: z.boolean().default(false).describe("true waits while the Session is running; false returns an immediate live snapshot. Default false."),
    timeout_ms: z.number().int().min(0).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS).describe("Max wait time in ms when blocking, from 0 to 1800000. Default 1800000 (30 minutes)."),
    full_session: z.boolean().default(false).describe("false pages through the latest assistant message; true pages through filtered stored messages. Default false."),
    cursor: BackgroundOutputCursorSchema.optional().describe("Exact forward cursor returned in the previous page's nextInput. Do not construct or modify it."),
    include_tool_results: z.boolean().default(false).describe("Include bounded unified tool previews, strict details, and recovery references in full_session output. Hidden by default."),
    include_reasoning: z.boolean().default(false).describe("Include assistant reasoning in full_session output. Hidden by default."),
  })
  .strict()
  .superRefine((input, ctx) => {
    const expectedMode = input.full_session ? "full_session" : "latest";
    if (input.cursor !== undefined && input.cursor.mode !== expectedMode) {
      ctx.addIssue({
        code: "custom",
        path: ["cursor", "mode"],
        message: `Cursor mode must be ${expectedMode} for this request`,
      });
    }
  });

export type BackgroundOutputInput = z.infer<typeof BackgroundOutputInputSchema>;
type BackgroundOutputCursor = NonNullable<BackgroundOutputInput["cursor"]>;
type WaitResult = "not_waited" | "stopped" | "timed_out" | "aborted";

interface OutputUnit {
  readonly text: string;
}

interface SourcePage {
  readonly text: string;
  readonly nextCursor?: BackgroundOutputCursor;
}

class InvalidBackgroundCursorError extends Error {
  constructor() {
    super("background_output cursor is invalid for the selected Session snapshot");
    this.name = "InvalidBackgroundCursorError";
  }
}

export async function executeBackgroundOutput(
  input: BackgroundOutputInput,
  ctx: ToolExecutionContext,
): Promise<RawToolResult> {
  const parentSessionId = ctx.store.getState().sessionId;
  if (input.session_id === parentSessionId) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_INVALID_BACKGROUND_SESSION",
      message: "background_output cannot read the current Session",
    });
  }

  let childStore: StoreApi<SessionStoreState> | undefined;
  try {
    childStore = await getChildStore(input.session_id, ctx);
  } catch (error) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_CHILD_SESSION_LOAD_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (childStore === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_CHILD_SESSION_NOT_FOUND",
      message: `Child Session store not found: ${input.session_id}`,
    });
  }
  if (childStore.getState().parentSessionId !== parentSessionId) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_CHILD_SESSION_NOT_DIRECT",
      message: `Session ${input.session_id} is not a direct child of ${parentSessionId}`,
    });
  }

  await recoverGoalReviewResultProjection(childStore, ctx);

  const waitResult = input.block && childStore.getState().isRunning
    ? await waitForChildToStop(childStore, input.timeout_ms, ctx.abort)
    : "not_waited";
  const state = childStore.getState();
  const execution = state.executions.at(-1);
  try {
    const page = createBackgroundOutputPage(input, childStore.getState(), waitResult);
    const nextInput: JsonObject | undefined = page.nextCursor === undefined
      ? undefined
      : { ...input, cursor: page.nextCursor } as JsonObject;
    return createSourceToolResult(page.text, nextInput);
  } catch (error) {
    if (error instanceof InvalidBackgroundCursorError) {
      return createToolErrorResult({
        kind: "execution",
        code: "TOOL_BACKGROUND_OUTPUT_INVALID_CURSOR",
        message: error.message,
        name: error.name,
      });
    }
    throw error;
  }
}

async function recoverGoalReviewResultProjection(
  childStore: StoreApi<SessionStoreState>,
  ctx: ToolExecutionContext,
): Promise<void> {
  const state = childStore.getState();
  const execution = state.executions.at(-1);
  if (
    state.agentName !== "reviewer"
    || state.sessionRole !== "review"
    || state.goalId === undefined
    || execution === undefined
    || state.childResultReceipts.some((receipt) => receipt.executionId === execution.id)
  ) return;

  const goal = await ctx.projectContext.goalState.read(state.goalId);
  const review = goal.review;
  if (
    review === undefined
    || review.reviewerSessionId !== state.sessionId
    || review.executionId !== execution.id
    || review.delegationContractHash !== state.delegationContractHash
  ) return;

  const projection = projectGoalReviewReceipt(review);
  await ctx.storeManager.commitDurableSessionMutation(
    state.sessionId,
    ctx.projectContext.project.workspaceRoot,
    (current) => current.childResultReceipts.some((receipt) => receipt.executionId === projection.executionId)
      ? { result: undefined }
      : { result: undefined, events: [{ type: "child-result", receipt: projection }] },
  );
}

async function getChildStore(
  sessionId: string,
  ctx: ToolExecutionContext,
): Promise<StoreApi<SessionStoreState> | undefined> {
  const workspaceRoot = ctx.projectContext.project.workspaceRoot;
  const liveStore = ctx.storeManager.get(sessionId, workspaceRoot);
  if (liveStore !== undefined) return liveStore;
  return await ctx.storeManager.getOrLoad(sessionId, workspaceRoot);
}

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

function receiptForExecution(
  receipts: readonly ChildResultReceipt[],
  executionId: string | undefined,
): ChildResultReceipt | undefined {
  if (executionId === undefined) return undefined;
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index];
    if (receipt?.executionId === executionId) return receipt;
  }
  return undefined;
}

function createBackgroundOutputPage(
  input: BackgroundOutputInput,
  state: SessionStoreState,
  waitResult: WaitResult,
): SourcePage {
  const header = renderHeader(input, state, waitResult);
  let text = header;
  let bytes = utf8ByteLength(text);
  let lines = lineCount(text);
  if (bytes > SOURCE_PAGE_MAX_BYTES || lines > SOURCE_PAGE_MAX_LINES) {
    throw new Error("background_output page header exceeds the source-page limit");
  }

  let cursor = initialCursor(input, state.messages);
  if (cursor === undefined) {
    const empty = input.full_session ? "_No messages are available._" : "_No assistant output yet._";
    return { text: `${text}\n\n${empty}` };
  }

  let emittedBody = false;
  while (cursor !== undefined) {
    const location = locateCursor(input, state.messages, cursor);
    const unit = location.units[cursor.unit_index];
    if (unit === undefined || cursor.text_offset > unit.text.length) {
      throw new InvalidBackgroundCursorError();
    }

    if (cursor.text_offset === unit.text.length) {
      cursor = nextUnitCursor(input, state.messages, location.messageIndex, cursor.unit_index);
      continue;
    }

    const separator = "\n\n";
    const separatorBytes = utf8ByteLength(separator);
    const separatorLines = 2;
    const availableBytes = SOURCE_PAGE_MAX_BYTES - bytes - separatorBytes;
    const availableSliceLines = SOURCE_PAGE_MAX_LINES - lines - separatorLines + 1;
    if (availableBytes <= 0 || availableSliceLines <= 0) break;

    const slice = sliceUtf8Head(unit.text, availableBytes, cursor.text_offset, availableSliceLines);
    if (slice.nextOffset === cursor.text_offset) break;

    text += separator + slice.text;
    bytes += separatorBytes + utf8ByteLength(slice.text);
    lines += separatorLines + lineCount(slice.text) - 1;
    emittedBody = true;

    if (slice.truncated) {
      cursor = { ...cursor, text_offset: slice.nextOffset };
      break;
    }
    cursor = nextUnitCursor(input, state.messages, location.messageIndex, cursor.unit_index);
  }

  if (!emittedBody && cursor !== undefined) {
    throw new Error("background_output could not advance within the bounded source page");
  }
  return {
    text,
    ...(cursor === undefined ? {} : { nextCursor: cursor }),
  };
}

function renderHeader(
  input: BackgroundOutputInput,
  state: SessionStoreState,
  waitResult: WaitResult,
): string {
  const snapshot = state.isRunning
    ? "Snapshot: false (live Session). This page reflects state at call time; later pages may observe appended or extended content."
    : "Snapshot: false (Session currently idle). This page reflects state at call time; a later resumed execution may append content.";
  const lines = [
    `# Background session ${state.sessionId}`,
    `Status: ${sessionStatus(state)}`,
    `Wait status: ${waitResult}`,
    snapshot,
    `Mode: ${input.full_session ? "full_session" : "latest"}`,
  ];
  const execution = state.executions.at(-1);
  const receipt = receiptForExecution(state.childResultReceipts, execution?.id);
  if (receipt !== undefined) lines.push(`Canonical result receipt: ${JSON.stringify(receipt)}`);
  else if (!state.isRunning && execution !== undefined) {
    lines.push("Canonical result receipt: missing. Assistant text does not satisfy the child result protocol.");
  }
  if (execution?.error !== undefined) lines.push(`Execution error: ${execution.error}`);
  const note = statusNote(state, waitResult);
  if (note.length > 0) lines.push(note);
  return lines.join("\n");
}

function initialCursor(
  input: BackgroundOutputInput,
  messages: readonly StoredMessage[],
): BackgroundOutputCursor | undefined {
  if (input.cursor !== undefined) return input.cursor;
  if (input.full_session) {
    const first = messages[0];
    return first === undefined
      ? undefined
      : { mode: "full_session", message_id: first.id, unit_index: 0, text_offset: 0 };
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    if (latestUnits(message).length === 0) continue;
    return { mode: "latest", message_id: message.id, unit_index: 0, text_offset: 0 };
  }
  return undefined;
}

function locateCursor(
  input: BackgroundOutputInput,
  messages: readonly StoredMessage[],
  cursor: BackgroundOutputCursor,
): { readonly messageIndex: number; readonly units: readonly OutputUnit[] } {
  const messageIndex = messages.findIndex((message) => message.id === cursor.message_id);
  if (messageIndex < 0) throw new InvalidBackgroundCursorError();
  const message = messages[messageIndex]!;
  if (cursor.mode === "latest" && message.role !== "assistant") throw new InvalidBackgroundCursorError();
  return {
    messageIndex,
    units: cursor.mode === "latest" ? latestUnits(message) : fullSessionUnits(message, input),
  };
}

function nextUnitCursor(
  input: BackgroundOutputInput,
  messages: readonly StoredMessage[],
  messageIndex: number,
  unitIndex: number,
): BackgroundOutputCursor | undefined {
  const message = messages[messageIndex]!;
  const units = input.full_session ? fullSessionUnits(message, input) : latestUnits(message);
  if (unitIndex + 1 < units.length) {
    return {
      mode: input.full_session ? "full_session" : "latest",
      message_id: message.id,
      unit_index: unitIndex + 1,
      text_offset: 0,
    };
  }
  if (!input.full_session) return undefined;
  const nextMessage = messages[messageIndex + 1];
  return nextMessage === undefined
    ? undefined
    : { mode: "full_session", message_id: nextMessage.id, unit_index: 0, text_offset: 0 };
}

function latestUnits(message: StoredMessage): OutputUnit[] {
  return message.parts.flatMap((part) => part.type === "text" && part.text.length > 0
    ? [{ text: part.text }]
    : []);
}

function fullSessionUnits(message: StoredMessage, input: BackgroundOutputInput): OutputUnit[] {
  const units: OutputUnit[] = [{ text: `## ${message.role} ${message.id}` }];
  for (const part of message.parts) units.push(...renderPartUnits(part, input));
  if (units.length === 1) units.push({ text: "_No visible parts._" });
  return units;
}

function renderPartUnits(part: StoredPart, input: BackgroundOutputInput): OutputUnit[] {
  switch (part.type) {
    case "text":
      return part.text.length === 0 ? [] : [{ text: part.text }];
    case "reasoning":
      return input.include_reasoning ? [{ text: "### Reasoning" }, { text: part.text }] : [];
    case "tool":
      return renderToolPartUnits(part, input.include_tool_results);
    case "compaction":
      return [{ text: "### Compaction" }, { text: part.summary }];
    case "system-notice":
      return [{ text: "### System notice" }, { text: part.notice }];
    case "recovery-notice":
      return [{ text: "### Recovery notice" }, { text: part.message }];
  }
}

function renderToolPartUnits(part: ToolPart, includeToolResults: boolean): OutputUnit[] {
  const units: OutputUnit[] = [{ text: `- Tool call: ${part.toolName} [${part.state}]` }];
  if (!includeToolResults || (part.state !== "completed" && part.state !== "error")) return units;
  units.push({ text: "```text" }, { text: part.result.output.preview }, { text: "```" });

  const details = visibleToolDetails(part.result.details);
  if (details !== undefined) units.push({ text: `Tool details: ${JSON.stringify(details)}` });
  if (part.result.output.recovery.kind !== "none") {
    units.push({ text: `Tool recovery: ${JSON.stringify(part.result.output.recovery)}` });
  }
  return units;
}

function visibleToolDetails(details: ToolResultDetails | undefined): Omit<ToolResultDetails, "presentations"> | undefined {
  if (details === undefined) return undefined;
  const visible = {
    ...(details.error === undefined ? {} : { error: details.error }),
    ...(details.process === undefined ? {} : { process: details.process }),
    ...(details.unknownResult === undefined ? {} : { unknownResult: true as const }),
  };
  return Object.keys(visible).length === 0 ? undefined : visible;
}

function sessionStatus(state: SessionStoreState): string {
  if (state.isRunning) return "running";
  return state.executions.at(-1)?.status ?? "idle";
}

function statusNote(state: SessionStoreState, waitResult: WaitResult): string {
  if (waitResult === "timed_out") return "Timed out waiting; this page is the current non-final snapshot.";
  if (waitResult === "aborted") return "Parent wait was aborted; this page is the current non-final snapshot.";
  if (state.isRunning) return "The Session is still running; this snapshot is not a final deliverable.";
  return "";
}

function lineCount(value: string): number {
  if (value.length === 0) return 0;
  let count = 1;
  for (const character of value) if (character === "\n") count += 1;
  return count;
}

export const backgroundOutputTool = defineTool({
  name: "background_output",
  description: [
    "Read a bounded status/output page and canonical result receipt for one direct child Session.",
    "It never treats assistant text as a child result. A terminal execution without result_receipt did not satisfy the child result protocol.",
    "Use block=true after a terminal reminder when the persisted receipt is required; do not poll.",
    "",
    "For a final child result, wait for its terminal reminder and call `background_output({\"session_id\":\"<session-id>\",\"block\":true,\"timeout_ms\":1800000})`. If status is still running, the returned live page is explicitly not a final deliverable.",
    "",
    "Every page is at most 50 KiB and 2,000 lines. When more content exists, call background_output again with the exact schema-valid nextInput returned by the tool; the cursor advances inside oversized text parts and across messages without an artifact or silent truncation. Use full_session=true for intermediate context. Reasoning and unified tool results remain hidden unless explicitly included.",
  ].join("\n"),
  inputSchema: BackgroundOutputInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  outputPolicy: { kind: "source", previewDirection: "head" },
  execute: executeBackgroundOutput,
});
