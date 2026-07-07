import type { HitlDisplayPayload, HitlOwnerKey, HitlRecord, HitlResponse, HitlSource, SessionHitlCheckpoint } from "@archcode/protocol";

import type { AskUserInput } from "../tools/builtins/ask-user";
import { formatAskUserAnswers } from "../tools/builtins/ask-user-format";
import { createToolErrorResult } from "../tools/errors";
import type { ToolExecutionContext, ToolConfirmationRequest } from "../tools/types";
import { redactString, redactValue } from "../tools/security/redaction";
import { writeSessionHitlCheckpoint, type SessionHitlCheckpointRecord } from "./session-hitl-checkpoint";

export class SessionHitlPause extends Error {
  constructor(
    public readonly record: HitlRecord,
    public readonly checkpoint: SessionHitlCheckpoint,
  ) {
    super(`Session execution is waiting for HITL response ${record.hitlId}`);
    this.name = "SessionHitlPause";
  }
}

export async function pauseForAskUser(input: AskUserInput, ctx: ToolExecutionContext): Promise<never> {
  const sessionId = ctx.store.getState().sessionId;
  const source: HitlSource = { type: "ask_user", sessionId, toolCallId: ctx.toolCallId };
  const blockingKey = `session:${sessionId}:ask:${ctx.toolCallId}`;
  const displayPayload = askUserDisplayPayload(input);
  const record = await createRecordAndCheckpoint({
    ctx,
    source,
    blockingKey,
    displayPayload,
    kind: "ask_user",
  });
  throw new SessionHitlPause(record, checkpointProjection(record, ctx, source));
}

export async function pauseForPermission(request: ToolConfirmationRequest, ctx: ToolExecutionContext): Promise<never> {
  const sessionId = ctx.store.getState().sessionId;
  const source: HitlSource = { type: "tool_permission", sessionId, toolCallId: ctx.toolCallId, toolName: ctx.toolName };
  const blockingKey = `session:${sessionId}:tool:${ctx.toolCallId}`;
  const displayPayload = permissionDisplayPayload(request);
  const record = await createRecordAndCheckpoint({
    ctx,
    source,
    blockingKey,
    displayPayload,
    kind: "permission",
    permission: {
      description: request.description,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.approval === undefined ? {} : { approval: request.approval }),
      ...(request.decisionDisplay === undefined ? {} : { decisionDisplay: request.decisionDisplay }),
      ...(request.ruleId === undefined ? {} : { ruleId: request.ruleId }),
    },
  });
  throw new SessionHitlPause(record, checkpointProjection(record, ctx, source));
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
  return { output: formatAskUserAnswers(answers, input.questions), isError: false };
}

async function createRecordAndCheckpoint(input: {
  readonly ctx: ToolExecutionContext;
  readonly source: HitlSource;
  readonly blockingKey: string;
  readonly displayPayload: HitlDisplayPayload;
  readonly kind: "ask_user" | "permission";
  readonly permission?: SessionHitlCheckpointRecord["permission"];
}): Promise<HitlRecord> {
  const { ctx } = input;
  const sessionId = ctx.store.getState().sessionId;
  const owner: HitlOwnerKey = {
    projectSlug: ctx.projectContext.project.slug,
    ownerType: "session",
    ownerId: sessionId,
  };
  const record = await ctx.projectContext.hitl.create({
    owner,
    blockingKey: input.blockingKey,
    source: input.source,
    displayPayload: input.displayPayload,
  });
  const createdAt = new Date().toISOString();
  const checkpoint: SessionHitlCheckpointRecord = {
    version: 1,
    hitlId: record.hitlId,
    blockingKey: record.blockingKey,
    source: record.source,
    toolCallId: ctx.toolCallId,
    toolName: ctx.toolName,
    step: ctx.step,
    ...(ctx.hitlCheckpoint?.assistantMessageId === undefined ? {} : { assistantMessageId: ctx.hitlCheckpoint.assistantMessageId }),
    rawToolInput: ctx.input,
    displayInput: ctx.redactedInput ?? redactValue(ctx.input),
    allowedTools: [...ctx.allowedTools],
    agentSkills: [...(ctx.agentSkills ?? [])],
    ...(ctx.agentName === undefined ? {} : { agentName: ctx.agentName }),
    ...(ctx.currentDepth === undefined ? {} : { currentDepth: ctx.currentDepth }),
    ...(ctx.origin === undefined ? {} : { origin: ctx.origin }),
    toolCalls: (ctx.hitlCheckpoint?.toolCalls ?? [{ toolCallId: ctx.toolCallId, toolName: ctx.toolName, input: ctx.input }]).map(cloneToolCall),
    completedToolResults: (ctx.hitlCheckpoint?.completedToolResults ?? []).map((result) => ({
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      output: result.output,
      isError: result.isError,
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    })),
    pendingToolCalls: (ctx.hitlCheckpoint?.pendingToolCalls ?? []).map(cloneToolCall),
    blockedToolIndex: ctx.hitlCheckpoint?.blockedToolIndex ?? 0,
    createdAt,
    kind: input.kind,
    ...(input.permission === undefined ? {} : { permission: input.permission }),
  };
  await writeSessionHitlCheckpoint(checkpoint, ctx.workspaceRoot, sessionId);
  ctx.store.getState().append({ type: "hitl.request", request: record });
  return record;
}

function checkpointProjection(record: HitlRecord, ctx: ToolExecutionContext, source: HitlSource): SessionHitlCheckpoint {
  return {
    version: 1,
    hitlId: record.hitlId,
    blockingKey: record.blockingKey,
    source,
    toolCallId: ctx.toolCallId,
    toolName: ctx.toolName,
    step: ctx.step,
    ...(ctx.hitlCheckpoint?.assistantMessageId === undefined ? {} : { assistantMessageId: ctx.hitlCheckpoint.assistantMessageId }),
    displayInput: ctx.redactedInput ?? redactValue(ctx.input),
    blockedAt: new Date().toISOString(),
    reason: record.displayPayload.title,
  };
}

function askUserDisplayPayload(input: AskUserInput): HitlDisplayPayload {
  const first = input.questions[0];
  return {
    title: safeDisplay(first?.header ?? "Question"),
    summary: safeDisplay(first?.question ?? "User input required"),
    fields: input.questions.map((question) => ({ label: safeDisplay(question.header), value: safeDisplay(question.question) })),
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
