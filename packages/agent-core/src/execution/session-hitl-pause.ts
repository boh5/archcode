import type { HitlDisplayPayload, HitlOwnerKey, HitlRecord, HitlResponse, SessionHitlBlocker } from "@archcode/protocol";

import type { AskUserInput } from "../tools/builtins/ask-user";
import { createAskUserSuccessResult } from "../tools/builtins/ask-user-format";
import { createToolErrorResult } from "../tools/errors";
import type { ToolExecutionContext, ToolConfirmationRequest } from "../tools/types";
import { redactString, redactValue } from "../tools/security/redaction";
import type { SessionHitlJournalEntry } from "./session-hitl-journal-store";
import { prepareSessionHitlPause, sessionHitlBlockerFromJournal } from "./session-hitl-journal";

export class SessionHitlPause extends Error {
  constructor(
    public readonly record: HitlRecord,
    public readonly blocker: SessionHitlBlocker,
  ) {
    super(`Session execution is waiting for HITL response ${record.hitlId}`);
    this.name = "SessionHitlPause";
  }
}

export async function pauseForAskUser(input: AskUserInput, ctx: ToolExecutionContext): Promise<never> {
  const sessionId = ctx.store.getState().sessionId;
  const source: SessionHitlJournalEntry["source"] = { type: "ask_user", sessionId, toolCallId: ctx.toolCallId };
  const blockingKey = `session:${sessionId}:ask:${ctx.toolCallId}`;
  const displayPayload = askUserDisplayPayload(input);
  const prepared = await createRecordAndEntry({
    ctx,
    source,
    blockingKey,
    displayPayload,
  });
  throw new SessionHitlPause(prepared.record, sessionHitlBlockerFromJournal(prepared.entry));
}

export async function pauseForPermission(request: ToolConfirmationRequest, ctx: ToolExecutionContext): Promise<never> {
  const sessionId = ctx.store.getState().sessionId;
  const source: SessionHitlJournalEntry["source"] = { type: "tool_permission", sessionId, toolCallId: ctx.toolCallId, toolName: ctx.toolName };
  const blockingKey = `session:${sessionId}:tool:${ctx.toolCallId}`;
  const displayPayload = permissionDisplayPayload(request);
  const prepared = await createRecordAndEntry({
    ctx,
    source,
    blockingKey,
    displayPayload,
    permission: {
      description: request.description,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.approval === undefined ? {} : { approval: request.approval }),
      ...(request.decisionDisplay === undefined ? {} : { decisionDisplay: request.decisionDisplay }),
      ...(request.ruleId === undefined ? {} : { ruleId: request.ruleId }),
    },
  });
  throw new SessionHitlPause(prepared.record, sessionHitlBlockerFromJournal(prepared.entry));
}

export function askUserResponseToToolResult(input: AskUserInput, response: HitlResponse): { output: string; isError: boolean } {
  if (response.type === "cancel") return createToolErrorResult({ kind: "cancelled", message: response.reason });
  if (response.type !== "question_answer") return createToolErrorResult({ kind: "cancelled", message: "Invalid HITL response for ask_user" });
  const answers = response.answers.map((answer) => [answer]);
  if (answers.length !== input.questions.length) {
    return createToolErrorResult({ kind: "cancelled", message: `ask_user received ${answers.length} answers but expected ${input.questions.length}` });
  }
  const emptyIndex = answers.findIndex((answer) => answer.length === 0 || answer[0]?.length === 0);
  if (emptyIndex !== -1) {
    return createToolErrorResult({ kind: "cancelled", message: `ask_user received empty answer for question ${emptyIndex + 1}` });
  }
  return createAskUserSuccessResult(answers, input.questions);
}

async function createRecordAndEntry(input: {
  readonly ctx: ToolExecutionContext;
  readonly source: SessionHitlJournalEntry["source"];
  readonly blockingKey: string;
  readonly displayPayload: HitlDisplayPayload;
  readonly permission?: SessionHitlJournalEntry["permission"];
}): Promise<{ readonly record: HitlRecord; readonly entry: SessionHitlJournalEntry }> {
  const { ctx } = input;
  const sessionId = ctx.store.getState().sessionId;
  const owner: HitlOwnerKey = {
    projectSlug: ctx.projectContext.project.slug,
    ownerType: "session",
    ownerId: sessionId,
  };
  const createdAt = new Date().toISOString();
  if (ctx.agentName === undefined) throw new Error("Session HITL entry requires agentName");
  if (ctx.agentSkills === undefined) throw new Error("Session HITL entry requires agentSkills");
  const entry: SessionHitlJournalEntry = {
    phase: "preparing",
    phaseUpdatedAt: createdAt,
    hitlId: crypto.randomUUID(),
    blockingKey: input.blockingKey,
    source: input.source,
    toolCallId: ctx.toolCallId,
    toolName: ctx.toolName,
    step: ctx.step,
    ...(ctx.hitlJournal?.assistantMessageId === undefined ? {} : { assistantMessageId: ctx.hitlJournal.assistantMessageId }),
    rawToolInput: ctx.input,
    displayInput: ctx.redactedInput ?? redactValue(ctx.input),
    allowedTools: [...ctx.allowedTools],
    agentSkills: [...ctx.agentSkills],
    agentName: ctx.agentName,
    ...(ctx.currentDepth === undefined ? {} : { currentDepth: ctx.currentDepth }),
    toolCalls: (ctx.hitlJournal?.toolCalls ?? [{ toolCallId: ctx.toolCallId, toolName: ctx.toolName, input: ctx.input }]).map(cloneToolCall),
    completedToolResults: (ctx.hitlJournal?.completedToolResults ?? []).map((result) => ({
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      output: result.output,
      isError: result.isError,
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    })),
    pendingToolCalls: (ctx.hitlJournal?.pendingToolCalls ?? []).map(cloneToolCall),
    blockedToolIndex: ctx.hitlJournal?.blockedToolIndex ?? 0,
    createdAt,
    request: {
      owner,
      displayPayload: input.displayPayload,
      createdAt,
    },
    ...(input.permission === undefined ? {} : { permission: input.permission }),
  };
  return await prepareSessionHitlPause({
    workspaceRoot: ctx.projectContext.project.workspaceRoot,
    sessionId,
    store: ctx.store,
    sessions: ctx.storeManager,
    hitl: ctx.projectContext.hitl,
    entry,
  });
}

function askUserDisplayPayload(input: AskUserInput): HitlDisplayPayload {
  const first = input.questions[0];
  return {
    title: safeDisplay(first?.header ?? "Question"),
    summary: safeDisplay(first?.question ?? "User input required"),
    questions: input.questions.map((question) => ({
      question: safeDisplay(question.question),
      header: safeDisplay(question.header),
      options: question.options.map((option) => ({
        label: safeDisplay(option.label),
        description: safeDisplay(option.description),
      })),
      ...(question.multiple === undefined ? {} : { multiple: question.multiple }),
      custom: question.custom,
    })),
    redacted: true,
  };
}

function permissionDisplayPayload(request: ToolConfirmationRequest): HitlDisplayPayload {
  return {
    title: safeDisplay(`Approve ${request.toolName}`),
    summary: safeDisplay(request.reason ?? request.description),
    fields: [
      { label: "Tool", value: safeDisplay(request.toolName) },
      { label: "Input", value: safeDisplay(JSON.stringify(redactValue(request.input))) },
      ...(request.decisionDisplay === undefined ? [] : [{ label: "Decision", value: safeDisplay(request.decisionDisplay) }]),
    ],
    redacted: true,
  };
}


function cloneToolCall(call: { readonly toolCallId: string; readonly toolName: string; readonly input: unknown }) {
  return { toolCallId: call.toolCallId, toolName: call.toolName, input: call.input };
}

function safeDisplay(value: string): string {
  return redactString(value).replaceAll("[REDACTED]", "[REDACTED]");
}
