import type {
  GlobalSSEHitlRealtimeEvent,
  GlobalSSEResourceChangedEvent,
  SessionEventPayload,
  StreamEvent,
  ToolChildSessionLinkStatus,
} from "./types";

const TERMINAL_CHILD_SESSION_STATUSES = new Set<ToolChildSessionLinkStatus>([
  "completed", "failed", "timed_out", "cancelled", "interrupted",
]);

export type TerminalChildSessionStatus = Extract<
  ToolChildSessionLinkStatus,
  "completed" | "failed" | "timed_out" | "cancelled" | "interrupted"
>;

type UnknownRecord = Record<string, unknown>;

export function isSessionEventPayload(value: unknown): value is SessionEventPayload {
  const event = record(value);
  if (event === undefined || typeof event.type !== "string") return false;

  switch (event.type) {
    case "shutdown":
      return exact(event, ["type"], ["reason"]) && optionalString(event.reason);
    case "execution-start":
      return exact(event, ["type", "executionId", "binding", "origin"])
        && isString(event.executionId) && isExecutionModelBinding(event.binding)
        && oneOf(event.origin, ["user_message", "tool_call", "tool_batch", "goal_claim"]);
    case "execution-end":
      return exact(event, ["type", "status"], ["error", "blockedByHitlIds", "blockedToolCallId"])
        && oneOf(event.status, ["completed", "max_steps", "failed", "aborted", "cancelled", "timed_out", "interrupted", "waiting_for_human"])
        && optionalString(event.error)
        && optionalArray(event.blockedByHitlIds, isString)
        && optionalString(event.blockedToolCallId);
    case "session.cwd_changed":
      return exact(event, ["type", "previousCwd", "cwd"])
        && isString(event.previousCwd) && isString(event.cwd);
    case "session.model_selection_changed":
      return exact(event, ["type", "modelSelection"])
        && isSessionModelSelection(event.modelSelection);
    case "session.message_accepted":
    case "session.message_edited":
    case "session.message_steer_claimed":
    case "session.message_steer_rolled_back":
      return exact(event, ["type", "message"]) && isPendingSessionMessage(event.message);
    case "session.message_deleted":
      return exact(event, ["type", "messageId", "clientRequestId", "revision", "deletedAt"])
        && isString(event.messageId)
        && isString(event.clientRequestId)
        && isNonNegativeInteger(event.revision)
        && isFiniteNumber(event.deletedAt);
    case "session.messages_committed":
      return exact(event, ["type", "executionId", "messages"])
        && isString(event.executionId)
        && arrayOf(
          event.messages,
          (message) => isCommittedUserMessage(message, event.executionId as string),
        );
    case "execution-stop-requested":
      return exact(event, ["type", "executionId", "timestamp"])
        && isString(event.executionId)
        && isFiniteNumber(event.timestamp);
    case "system-notice":
      return exact(event, ["type", "message"]) && isString(event.message);
    case "text-start":
    case "text-end":
    case "reasoning-start":
    case "reasoning-end":
      return exact(event, ["type"]);
    case "text-delta":
    case "reasoning-delta":
      return exact(event, ["type", "text"]) && isString(event.text);
    case "tool-input-start":
      return exact(event, ["type", "toolCallId", "toolName"])
        && isString(event.toolCallId) && isString(event.toolName);
    case "tool-call":
    case "tool-input-resolved":
      return exact(event, ["type", "toolCallId", "toolName", "input"])
        && isString(event.toolCallId) && isString(event.toolName);
    case "tool-attempt":
      return exact(event, ["type", "toolCallId", "toolName", "attemptId", "timestamp", "destructive"])
        && isString(event.toolCallId) && isString(event.toolName) && isString(event.attemptId)
        && isFiniteNumber(event.timestamp) && typeof event.destructive === "boolean";
    case "tool-result":
      return exact(event, ["type", "toolCallId", "toolName", "output", "isError"], ["meta"])
        && isString(event.toolCallId) && isString(event.toolName) && isString(event.output)
        && typeof event.isError === "boolean"
        && (event.meta === undefined || record(event.meta) !== undefined);
    case "tool-child-session-link":
      return exact(event, ["type", "link"]) && isToolChildSessionLink(event.link);
    case "todo-write":
      return exact(event, ["type", "todos"]) && arrayOf(event.todos, isSessionTodo);
    case "reminder":
      return exact(event, ["type", "reminder"]) && isReminder(event.reminder);
    case "reminder-consumed":
      return exact(event, ["type", "reminderIds"]) && arrayOf(event.reminderIds, isString);
    case "step-start":
      return exact(event, ["type", "step"]) && isFiniteNumber(event.step);
    case "step-end":
      return exact(event, ["type", "step", "finishReason"], ["usage"])
        && isFiniteNumber(event.step) && isString(event.finishReason);
    case "execution-error":
      return exact(event, ["type", "error"], ["step"])
        && isString(event.error) && optionalFiniteNumber(event.step);
    case "llm-retry":
      return isLlmRecoveryEvent(event, true, false);
    case "llm-recovery":
      return isLlmRecoveryEvent(event, false, false);
    case "llm-recovery-failed":
      return isLlmRecoveryEvent(event, true, true);
    case "compact":
      return exact(event, ["type", "summary", "tailStartId"])
        && isString(event.summary) && isString(event.tailStartId);
    case "compression.block_committed":
      return exact(event, ["type", "block"], ["state"])
        && isCompressionBlock(event.block)
        && (event.state === undefined || isCompressionState(event.state));
    case "compression.block_failed":
      return exact(event, ["type", "failure"], ["state"])
        && isCompressionFailure(event.failure)
        && (event.state === undefined || isCompressionState(event.state));
    case "compression.ref_map_updated":
      return exact(event, ["type", "refMap"], ["updatedAt"])
        && isCompressionRefMap(event.refMap) && optionalFiniteNumber(event.updatedAt);
    default:
      return false;
  }
}

function isPendingSessionMessage(value: unknown): boolean {
  const message = record(value);
  if (message === undefined
    || !exact(
      message,
      ["id", "clientRequestId", "content", "source", "state", "revision", "acceptedAt", "updatedAt", "requestedModelSelection"],
      ["targetExecutionId"],
    )
    || !isString(message.id)
    || !isString(message.clientRequestId)
    || !isString(message.content)
    || !oneOf(message.source, ["user", "automation"])
    || !oneOf(message.state, ["queued", "steering"])
    || !isNonNegativeInteger(message.revision)
    || !isFiniteNumber(message.acceptedAt)
    || !isFiniteNumber(message.updatedAt)
    || !isRequestedModelSelection(message.requestedModelSelection)
    || !optionalString(message.targetExecutionId)) return false;

  return message.state === "steering"
    ? typeof message.targetExecutionId === "string"
    : message.targetExecutionId === undefined;
}

function isCommittedUserMessage(value: unknown, executionId: string): boolean {
  const message = record(value);
  const parts = message?.parts;
  return message !== undefined
    && exact(
      message,
      ["id", "role", "parts", "createdAt"],
      ["completedAt", "executionId", "clientRequestId", "compacted", "modelAudit"],
    )
    && isString(message.id)
    && message.role === "user"
    && Array.isArray(parts)
    && arrayOf(parts, isCommittedUserTextPart)
    && parts.length > 0
    && isFiniteNumber(message.createdAt)
    && optionalFiniteNumber(message.completedAt)
    && message.executionId === executionId
    && optionalString(message.clientRequestId)
    && isMessageModelAudit(message.modelAudit)
    && (message.compacted === undefined || typeof message.compacted === "boolean");
}

function isModelSelectionRef(value: unknown): boolean {
  const selection = record(value);
  return selection !== undefined
    && exact(selection, ["model"], ["variant"])
    && isString(selection.model)
    && optionalString(selection.variant);
}

function isRequestedModelSelection(value: unknown): boolean {
  const requested = record(value);
  return requested !== undefined
    && exact(requested, ["mode", "selection"])
    && oneOf(requested.mode, ["agent_default", "session_override"])
    && isModelSelectionRef(requested.selection);
}

function isSessionModelSelection(value: unknown): boolean {
  const selection = record(value);
  return selection !== undefined
    && exact(selection, ["revision"], ["override"])
    && isNonNegativeInteger(selection.revision)
    && (selection.override === undefined || isModelSelectionRef(selection.override));
}

function isExecutionModelBinding(value: unknown): boolean {
  const binding = record(value);
  return binding !== undefined
    && exact(binding, ["selection", "providerId", "modelId", "providerDisplayName", "modelDisplayName", "resolution", "modelRuntimeRevision"])
    && isModelSelectionRef(binding.selection)
    && isString(binding.providerId)
    && isString(binding.modelId)
    && isString(binding.providerDisplayName)
    && isString(binding.modelDisplayName)
    && oneOf(binding.resolution, ["requested", "session_override", "agent_default"])
    && isString(binding.modelRuntimeRevision);
}

function isMessageModelAudit(value: unknown): boolean {
  const audit = record(value);
  return audit !== undefined
    && exact(audit, ["requested", "actual"], ["reason"])
    && isRequestedModelSelection(audit.requested)
    && isModelSelectionRef(audit.actual)
    && (audit.reason === undefined || audit.reason === "config_invalidated");
}

function isCommittedUserTextPart(value: unknown): boolean {
  const part = record(value);
  return part !== undefined
    && exact(part, ["type", "id", "text", "createdAt"], ["completedAt", "meta"])
    && part.type === "text"
    && isString(part.id)
    && isString(part.text)
    && isFiniteNumber(part.createdAt)
    && optionalFiniteNumber(part.completedAt)
    && (part.meta === undefined || record(part.meta) !== undefined);
}

export function isStreamEvent(event: unknown): event is StreamEvent {
  return isSessionEventPayload(event) && event.type !== "shutdown";
}

export function isGlobalSSEHitlRealtimeEvent(value: unknown): value is GlobalSSEHitlRealtimeEvent {
  const event = record(value);
  if (event === undefined
    || !exact(event, ["type", "projectSlug", "hitlId", "createdAt", "payload", "view"])
    || event.type !== "hitl.event"
    || !isString(event.projectSlug)
    || !isString(event.hitlId)
    || !isFiniteNumber(event.createdAt)
    || !isGlobalHitlPayload(event.payload)
    || !isHitlView(event.view)) return false;

  const view = event.view as UnknownRecord;
  return view.hitlId === event.hitlId;
}

export function isGlobalSSEResourceChangedEvent(value: unknown): value is GlobalSSEResourceChangedEvent {
  const event = record(value);
  return event !== undefined
    && exact(event, ["type", "projectSlug", "resourceType", "resourceId", "createdAt"])
    && event.type === "resource.changed"
    && isString(event.projectSlug)
    && oneOf(event.resourceType, ["goal", "automation", "todo"])
    && isString(event.resourceId)
    && isFiniteNumber(event.createdAt);
}

export function isTerminalChildSessionStatus(
  status: ToolChildSessionLinkStatus,
): status is TerminalChildSessionStatus {
  return TERMINAL_CHILD_SESSION_STATUSES.has(status);
}

function isSessionTodo(value: unknown): boolean {
  const todo = record(value);
  return todo !== undefined
    && exact(todo, ["id", "content", "status"], ["createdAt", "updatedAt"])
    && isString(todo.id) && isString(todo.content)
    && oneOf(todo.status, ["pending", "in_progress", "completed", "cancelled"])
    && optionalFiniteNumber(todo.createdAt) && optionalFiniteNumber(todo.updatedAt);
}

function isToolChildSessionLink(value: unknown): boolean {
  const link = record(value);
  return link !== undefined
    && exact(
      link,
      ["parentSessionId", "parentToolCallId", "toolName", "childSessionId", "childAgentName", "title", "depth", "background", "status", "createdAt"],
      ["description", "startedAt", "endedAt", "durationMs", "summary", "error"],
    )
    && isString(link.parentSessionId) && isString(link.parentToolCallId) && isString(link.toolName)
    && isString(link.childSessionId) && isString(link.childAgentName)
    && isFiniteNumber(link.depth) && typeof link.background === "boolean"
    && oneOf(link.status, ["linked", "running", "waiting_for_human", "cancelling", "completed", "failed", "timed_out", "cancelled", "interrupted"])
    && isFiniteNumber(link.createdAt) && isString(link.title) && optionalString(link.description)
    && optionalFiniteNumber(link.startedAt) && optionalFiniteNumber(link.endedAt)
    && optionalFiniteNumber(link.durationMs) && optionalString(link.summary) && optionalString(link.error);
}

function isReminder(value: unknown): boolean {
  const reminder = record(value);
  return reminder !== undefined
    && exact(reminder, ["id", "source", "delivery", "content", "createdAt", "consumedAt"], ["sessionId", "terminalState", "payload", "targetSessionId"])
    && isString(reminder.id) && isReminderSource(reminder.source)
    && oneOf(reminder.delivery, ["auto_inject", "on_demand"])
    && optionalString(reminder.sessionId) && optionalString(reminder.terminalState)
    && isString(reminder.content) && isFiniteNumber(reminder.createdAt)
    && (reminder.consumedAt === null || isFiniteNumber(reminder.consumedAt))
    && optionalString(reminder.targetSessionId);
}

function isReminderSource(value: unknown): boolean {
  const source = record(value);
  if (source === undefined || typeof source.type !== "string") return false;
  if (source.type === "todo_step_reminder" || source.type === "todo_loop_continuation") {
    return exact(source, ["type", "pendingTodos"]) && arrayOf(source.pendingTodos, isSessionTodo);
  }
  if (oneOf(source.type, ["subagent_completed", "subagent_failed", "subagent_timed_out", "subagent_cancelled"])) {
    return exact(source, ["type", "sessionId"]) && isString(source.sessionId);
  }
  return false;
}

function isLlmRecoveryEvent(event: UnknownRecord, requiresErrorKind: boolean, failed: boolean): boolean {
  const required = ["type", "scope", "visibility", "attempt", "message"];
  if (requiresErrorKind) required.push("errorKind");
  const optional = ["profile", "stepId", "messageId", "toolCallId"];
  if (!requiresErrorKind) optional.push("errorKind");
  if (failed) optional.push("statusCode");
  if (event.type === "llm-retry") optional.push("nextRetryAt");
  return exact(event, required, optional)
    && (failed ? event.scope === "session" : oneOf(event.scope, ["short", "session"]))
    && (failed ? event.visibility === "session" : oneOf(event.visibility, ["internal", "session"]))
    && optionalString(event.profile)
    && optionalString(event.errorKind)
    && isFiniteNumber(event.attempt) && isString(event.message)
    && optionalFiniteNumber(event.nextRetryAt)
    && optionalFiniteNumber(event.statusCode)
    && optionalString(event.stepId) && optionalString(event.messageId) && optionalString(event.toolCallId);
}

function isCompressionRefMap(value: unknown): boolean {
  const refMap = record(value);
  return refMap !== undefined
    && exact(refMap, ["messageRefsById", "messageIdsByRef", "blockRefsById", "blockIdsByRef", "nextMessageIndex", "nextBlockIndex"])
    && keyedRecord(refMap.messageRefsById, isString, isMessageRef)
    && keyedRecord(refMap.messageIdsByRef, isMessageRef, isString)
    && keyedRecord(refMap.blockRefsById, isString, isBlockRef)
    && keyedRecord(refMap.blockIdsByRef, isBlockRef, isString)
    && isFiniteNumber(refMap.nextMessageIndex) && isFiniteNumber(refMap.nextBlockIndex);
}

function isCompressionRange(value: unknown): boolean {
  const range = record(value);
  return range !== undefined
    && exact(range, ["startMessageId", "endMessageId", "startRef", "endRef", "startIndex", "endIndex"])
    && isString(range.startMessageId) && isString(range.endMessageId)
    && isMessageRef(range.startRef) && isMessageRef(range.endRef)
    && isFiniteNumber(range.startIndex) && isFiniteNumber(range.endIndex);
}

function isCompressionTokenEstimate(value: unknown): boolean {
  const estimate = record(value);
  return estimate !== undefined
    && exact(estimate, ["originalTokens", "summaryTokens", "savedTokens", "estimatedAt"])
    && isFiniteNumber(estimate.originalTokens) && isFiniteNumber(estimate.summaryTokens)
    && isFiniteNumber(estimate.savedTokens) && isFiniteNumber(estimate.estimatedAt);
}

function isCompressionBlock(value: unknown): boolean {
  const block = record(value);
  return block !== undefined
    && exact(
      block,
      ["id", "ref", "status", "strategy", "trigger", "range", "summary", "childBlockRefs", "protectedRefs", "createdAt", "updatedAt"],
      ["tokenEstimate", "deactivatedAt", "supersededBy"],
    )
    && isString(block.id) && isBlockRef(block.ref)
    && oneOf(block.status, ["active", "inactive", "superseded"])
    && block.strategy === "dynamic-range"
    && oneOf(block.trigger, ["model_tool_call", "soft_nudge_response", "strong_nudge_response"])
    && isCompressionRange(block.range) && isString(block.summary)
    && arrayOf(block.childBlockRefs, isBlockRef)
    && arrayOf(block.protectedRefs, (item) => isMessageRef(item) || isBlockRef(item))
    && (block.tokenEstimate === undefined || isCompressionTokenEstimate(block.tokenEstimate))
    && isFiniteNumber(block.createdAt) && isFiniteNumber(block.updatedAt)
    && optionalFiniteNumber(block.deactivatedAt)
    && (block.supersededBy === undefined || isBlockRef(block.supersededBy));
}

function isCompressionFailure(value: unknown): boolean {
  const failure = record(value);
  return failure !== undefined
    && exact(failure, ["id", "reason", "failedAt"], ["startRef", "endRef", "strategy"])
    && isString(failure.id) && isString(failure.reason)
    && (failure.startRef === undefined || isMessageRef(failure.startRef))
    && (failure.endRef === undefined || isMessageRef(failure.endRef))
    && (failure.strategy === undefined || failure.strategy === "dynamic-range")
    && isFiniteNumber(failure.failedAt);
}

function isCompressionState(value: unknown): boolean {
  const state = record(value);
  return state !== undefined
    && exact(state, ["refMap", "blocksByRef", "activeBlockRefs", "inactiveBlockRefs", "supersededBlockRefs", "failures"], ["updatedAt"])
    && isCompressionRefMap(state.refMap)
    && keyedRecord(state.blocksByRef, isBlockRef, isCompressionBlock)
    && arrayOf(state.activeBlockRefs, isBlockRef)
    && arrayOf(state.inactiveBlockRefs, isBlockRef)
    && arrayOf(state.supersededBlockRefs, isBlockRef)
    && arrayOf(state.failures, isCompressionFailure)
    && optionalFiniteNumber(state.updatedAt);
}

function isGlobalHitlPayload(value: unknown): boolean {
  const payload = record(value);
  return payload !== undefined
    && exact(payload, ["type"])
    && oneOf(payload.type, ["hitl.request", "hitl.updated", "hitl.resolved"]);
}

function isHitlView(value: unknown): boolean {
  const view = record(value);
  return view !== undefined
    && exact(
      view,
      ["hitlId", "owner", "source", "status", "displayPayload", "allowedActions", "createdAt", "updatedAt"],
      ["persistentApprovalEligible", "requiresInspection", "resolvedAt"],
    )
    && isString(view.hitlId)
    && isHitlOwner(view.owner)
    && isHitlSource(view.source)
    && oneOf(view.status, ["pending", "answered", "resolved", "cancelled"])
    && isHitlDisplayPayload(view.displayPayload)
    && (view.persistentApprovalEligible === undefined || typeof view.persistentApprovalEligible === "boolean")
    && arrayOf(view.allowedActions, (action) => oneOf(action, ["answer", "approve", "deny", "cancel"]))
    && (view.requiresInspection === undefined || view.requiresInspection === true)
    && isString(view.createdAt)
    && isString(view.updatedAt)
    && optionalString(view.resolvedAt);
}

function isHitlOwner(value: unknown): boolean {
  const owner = record(value);
  return owner !== undefined
    && exact(owner, ["type", "id"])
    && oneOf(owner.type, ["session", "goal"]) && isString(owner.id);
}

function isHitlSource(value: unknown): boolean {
  const source = record(value);
  if (source === undefined || typeof source.type !== "string") return false;
  switch (source.type) {
    case "ask_user":
      return exact(source, ["type", "toolCallId"])
        && isString(source.toolCallId);
    case "tool_permission":
      return exact(source, ["type", "toolCallId", "toolName"])
        && isString(source.toolCallId) && isString(source.toolName);
    case "goal_budget":
      return exact(source, ["type", "approvalPoint"])
        && isString(source.approvalPoint);
    default:
      return false;
  }
}

function isHitlDisplayPayload(value: unknown): boolean {
  const display = record(value);
  return display !== undefined
    && exact(display, ["title", "redacted"], ["summary", "fields", "questions"])
    && isString(display.title) && display.redacted === true && optionalString(display.summary)
    && optionalArray(display.fields, (item) => {
      const field = record(item);
      return field !== undefined && exact(field, ["label", "value"])
        && isString(field.label) && isString(field.value);
    })
    && optionalArray(display.questions, isHitlQuestion);
}

function isHitlQuestion(value: unknown): boolean {
  const question = record(value);
  return question !== undefined
    && exact(question, ["question", "header", "custom"], ["options", "multiple"])
    && isString(question.question) && isString(question.header) && typeof question.custom === "boolean"
    && optionalArray(question.options, (item) => {
      const option = record(item);
      return option !== undefined && exact(option, ["label", "description"])
        && isString(option.label) && isString(option.description);
    })
    && (question.multiple === undefined || typeof question.multiple === "boolean");
}

function isHitlResponse(value: unknown): boolean {
  const response = record(value);
  if (response === undefined || typeof response.type !== "string") return false;
  switch (response.type) {
    case "question_answer":
      return exact(response, ["type", "answers"], ["comment", "answeredBy"])
        && arrayOf(response.answers, isString) && optionalString(response.comment) && optionalString(response.answeredBy);
    case "permission_decision":
      return exact(response, ["type", "decision"], ["comment", "decidedBy"])
        && oneOf(response.decision, ["approve_once", "approve_always", "deny"])
        && optionalString(response.comment) && optionalString(response.decidedBy);
    case "budget_decision":
      return exact(response, ["type", "decision"], ["comment", "decidedBy"])
        && oneOf(response.decision, ["approved", "denied"])
        && optionalString(response.comment) && optionalString(response.decidedBy);
    case "cancel":
      return exact(response, ["type", "reason"], ["cancelledBy"])
        && isString(response.reason) && optionalString(response.cancelledBy);
    default:
      return false;
  }
}

function isGoalReviewReceipt(value: unknown): boolean {
  const receipt = record(value);
  return receipt !== undefined
    && exact(receipt, ["reviewGeneration", "verdict", "summary", "evidenceRefs", "reviewerSessionId", "decidedAt"], ["unresolvedItems"])
    && isFiniteNumber(receipt.reviewGeneration) && oneOf(receipt.verdict, ["DONE", "NOT_DONE"])
    && isString(receipt.summary) && arrayOf(receipt.evidenceRefs, isGoalEvidenceRef)
    && optionalArray(receipt.unresolvedItems, isString)
    && isString(receipt.reviewerSessionId) && isString(receipt.decidedAt);
}

function isGoalEvidenceRef(value: unknown): boolean {
  const evidence = record(value);
  return evidence !== undefined
    && exact(evidence, ["kind", "ref", "summary"], ["sessionId", "messageId", "toolCallId", "path", "url", "createdAt"])
    && oneOf(evidence.kind, ["session", "message", "tool_call", "diff", "test_output", "file", "url", "hitl"])
    && isString(evidence.ref) && isString(evidence.summary)
    && optionalString(evidence.sessionId) && optionalString(evidence.messageId)
    && optionalString(evidence.toolCallId) && optionalString(evidence.path)
    && optionalString(evidence.url) && optionalString(evidence.createdAt);
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function exact(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function arrayOf(value: unknown, predicate: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(predicate);
}

function optionalArray(value: unknown, predicate: (item: unknown) => boolean): boolean {
  return value === undefined || arrayOf(value, predicate);
}

function keyedRecord(
  value: unknown,
  keyPredicate: (key: unknown) => boolean,
  valuePredicate: (item: unknown) => boolean,
): boolean {
  const entries = record(value);
  return entries !== undefined
    && Object.entries(entries).every(([key, item]) => keyPredicate(key) && valuePredicate(item));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function optionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function oneOf(value: unknown, values: readonly unknown[]): boolean {
  return values.includes(value);
}

function isMessageRef(value: unknown): boolean {
  return isString(value) && /^m.+$/.test(value);
}

function isBlockRef(value: unknown): boolean {
  return isString(value) && /^b\d+$/.test(value);
}
