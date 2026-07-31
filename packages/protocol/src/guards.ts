import type {
  GlobalSSEHitlRealtimeEvent,
  GlobalSSEHitlSnapshotEvent,
  GlobalSSEResourceChangedEvent,
  FinalizedToolResult,
  SessionEventPayload,
  StreamEvent,
  ToolChildSessionLinkStatus,
} from "./types";
import type { GlobalSSEUpdateChangedEvent, UpdateStatus } from "./update";
import {
  COMPRESSION_SUMMARY_SECTION_NAMES,
  isMaterializedCompressionSummarySnapshot,
  type CompressionSummarySnapshot,
} from "./compression";
import {
  SESSION_GOAL_BLOCKED_REASON_MAX_LENGTH,
  SESSION_GOAL_OBJECTIVE_MAX_LENGTH,
  type SessionGoalChangedEvent,
} from "./session-goal";
import {
  isValidAttachmentMediaType,
  isValidAttachmentName,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "./attachments";

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
      return exact(event, ["type", "executionId", "origin", "maxSteps", "binding"], ["activeTimeoutMs"])
        && isString(event.executionId) && isExecutionModelBinding(event.binding)
        && oneOf(event.origin, ["user_message", "tool_call", "goal_continuation"])
        && isPositiveSafeInteger(event.maxSteps)
        && (event.activeTimeoutMs === undefined || isPositiveSafeInteger(event.activeTimeoutMs));
    case "execution-suspended":
      return exact(event, [
        "type", "executionId", "suspension", "runEndedAt", "runUsageDelta", "runSettlement",
      ])
        && isString(event.executionId)
        && isExecutionSuspension(event.suspension)
        && isNonNegativeSafeInteger(event.runEndedAt)
        && isNormalizedUsage(event.runUsageDelta)
        && isExecutionSettlementInput(event.runSettlement);
    case "execution-suspension-updated":
      return exact(event, ["type", "executionId", "suspension"])
        && isString(event.executionId)
        && isExecutionSuspension(event.suspension);
    case "execution-resumed":
      return exact(event, ["type", "executionId", "runOrdinal", "binding"])
        && isString(event.executionId)
        && isNonNegativeSafeInteger(event.runOrdinal)
        && isExecutionModelBinding(event.binding);
    case "execution-end":
      return exact(event, [
        "type", "executionId", "terminalStatus", "endedAt", "terminalSettlement",
      ], ["finalOutputStepId", "runEndedAt", "runUsageDelta", "runSettlement", "error"])
        && isString(event.executionId)
        && oneOf(event.terminalStatus, ["completed", "max_steps", "failed", "aborted", "cancelled", "timed_out", "interrupted"])
        && (event.finalOutputStepId === undefined
          || (event.terminalStatus === "completed" && isString(event.finalOutputStepId)))
        && isNonNegativeSafeInteger(event.endedAt)
        && ((event.runEndedAt === undefined
          && event.runUsageDelta === undefined
          && event.runSettlement === undefined)
          || (isNonNegativeSafeInteger(event.runEndedAt)
            && isNormalizedUsage(event.runUsageDelta)
            && isExecutionSettlementInput(event.runSettlement)))
        && isExecutionSettlementInput(event.terminalSettlement)
        && optionalString(event.error)
        ;
    case "session.cwd_changed":
      return exact(event, ["type", "previousCwd", "cwd"])
        && isString(event.previousCwd) && isString(event.cwd);
    case "session.model_selection_changed":
      return exact(event, ["type", "modelSelection"])
        && isSessionModelSelection(event.modelSelection);
    case "session.goal_changed":
      return exact(event, ["type", "action", "instanceId", "generation", "goal", "occurredAt"], ["status", "reason"])
        && oneOf(event.action, [
          "created", "edited", "paused", "resumed", "cleared", "budget_updated",
          "blocked", "usage_recorded", "completed",
        ])
        && isString(event.instanceId)
        && isNonNegativeInteger(event.generation)
        && (event.goal === null || isSessionGoalSnapshot(event.goal))
        && (event.status === undefined || oneOf(event.status, ["active", "paused", "blocked", "budget_limited", "complete"]))
        && optionalString(event.reason)
        && isFiniteNumber(event.occurredAt);
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
      return exact(event, ["type", "stepId", "blockId"])
        && isString(event.stepId) && isNonBlankString(event.blockId);
    case "text-delta":
    case "reasoning-delta":
      return exact(event, ["type", "stepId", "blockId", "text"])
        && isString(event.stepId) && isNonBlankString(event.blockId) && isString(event.text);
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
    case "tool-output-delta":
      return exact(event, [
        "type",
        "toolCallId",
        "toolName",
        "delta",
        "omittedBytes",
        "liveLimitReached",
      ])
        && isString(event.toolCallId)
        && event.toolName === "bash"
        && isString(event.delta)
        && utf8ByteLength(event.delta) <= 4 * 1024
        && isNonNegativeSafeInteger(event.omittedBytes)
        && typeof event.liveLimitReached === "boolean";
    case "tool-result":
      return exact(event, ["type", "toolCallId", "toolName", "settledAt", "result"])
        && isString(event.toolCallId) && isString(event.toolName)
        && isNonNegativeSafeInteger(event.settledAt)
        && isFinalizedToolResult(event.result);
    case "tool-child-session-link":
      return exact(event, ["type", "link"]) && isToolChildSessionLink(event.link);
    case "todo-write":
      return exact(event, ["type", "todos"]) && arrayOf(event.todos, isSessionTodo);
    case "reminder":
      return exact(event, ["type", "reminder"]) && isReminder(event.reminder);
    case "reminder-consumed":
      return exact(event, ["type", "reminderIds"]) && arrayOf(event.reminderIds, isString);
    case "step-start":
      return exact(event, ["type", "stepId", "step"])
        && isString(event.stepId) && isNonNegativeSafeInteger(event.step);
    case "step-end":
      return exact(event, ["type", "stepId", "step", "finishReason"], ["usage"])
        && isString(event.stepId) && isNonNegativeSafeInteger(event.step)
        && isString(event.finishReason);
    case "execution-error":
      return exact(event, ["type", "error"], ["step", "stepId"])
        && isString(event.error)
        && ((event.step === undefined && event.stepId === undefined)
          || (isFiniteNumber(event.step) && isString(event.stepId)));
    case "prompt-trace":
      return exact(event, ["type", "trace"]) && isPromptTrace(event.trace);
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

function isPromptTrace(value: unknown): boolean {
  const trace = record(value);
  return trace !== undefined
    && exact(trace, ["version", "status", "hash", "sections", "skills", "visibleTools", "agentsMd", "memory", "mcp", "warnings"])
    && trace.version === "2"
    && oneOf(trace.status, ["compiled", "error"])
    && isString(trace.hash)
    && arrayOf(trace.sections, (value) => {
      const section = record(value);
      return section !== undefined
        && exact(section, ["name", "source", "hash"])
        && isString(section.name) && isString(section.source) && isString(section.hash);
    })
    && isPromptTraceSkills(trace.skills)
    && arrayOf(trace.visibleTools, isString)
    && oneOf(trace.agentsMd, ["present", "absent", "error"])
    && oneOf(trace.memory, ["present", "absent", "error"])
    && record(trace.mcp) !== undefined
    && Object.values(trace.mcp as UnknownRecord).every((status) => oneOf(status, ["pending", "ready", "ready-zero", "partial-warning", "failed"]))
    && arrayOf(trace.warnings, isString);
}

function isPromptTraceSkills(value: unknown): boolean {
  const skills = record(value);
  return skills !== undefined
    && exact(skills, ["status", "active"])
    && oneOf(skills.status, ["present", "absent", "error"])
    && arrayOf(skills.active, (value) => {
      const active = record(value);
      return active !== undefined
        && exact(active, ["name", "source"])
        && isString(active.name) && isString(active.source);
    });
}

function isPendingSessionMessage(value: unknown): boolean {
  const message = record(value);
  if (message === undefined
    || !exact(
      message,
      ["id", "clientRequestId", "content", "attachments", "source", "state", "revision", "acceptedAt", "updatedAt", "requestedModelSelection"],
      ["targetExecutionId", "targetRunOrdinal", "targetModelAudit", "claimedAt"],
    )
    || !isString(message.id)
    || !isString(message.clientRequestId)
    || !isString(message.content)
    || !isAttachmentDescriptorArray(message.attachments)
    || !oneOf(message.source, ["user", "automation"])
    || !oneOf(message.state, ["queued", "steering"])
    || !isNonNegativeInteger(message.revision)
    || !isFiniteNumber(message.acceptedAt)
    || !isFiniteNumber(message.updatedAt)
    || !isRequestedModelSelection(message.requestedModelSelection)
    || !optionalString(message.targetExecutionId)
    || (message.targetRunOrdinal !== undefined && !isNonNegativeSafeInteger(message.targetRunOrdinal))
    || (message.targetModelAudit !== undefined && !isMessageModelAudit(message.targetModelAudit))
    || !optionalFiniteNumber(message.claimedAt)
    || ((message.content as string).trim().length === 0 && (message.attachments as unknown[]).length === 0)) return false;

  return message.state === "steering"
    ? typeof message.targetExecutionId === "string"
      && isNonNegativeSafeInteger(message.targetRunOrdinal)
      && isMessageModelAudit(message.targetModelAudit)
      && isFiniteNumber(message.claimedAt)
    : message.targetExecutionId === undefined
      && message.targetRunOrdinal === undefined
      && message.targetModelAudit === undefined
      && message.claimedAt === undefined;
}

function isCommittedUserMessage(value: unknown, executionId: string): boolean {
  const message = record(value);
  const parts = message?.parts;
  return message !== undefined
    && exact(
      message,
      ["id", "role", "parts", "createdAt"],
      ["completedAt", "executionId", "runOrdinal", "clientRequestId", "compacted", "modelAudit"],
    )
    && isString(message.id)
    && message.role === "user"
    && Array.isArray(parts)
    && arrayOf(parts, (part) => isCommittedUserTextPart(part) || isCommittedUserAttachmentPart(part))
    && parts.length > 0
    && hasValidCommittedUserContent(parts)
    && isFiniteNumber(message.createdAt)
    && optionalFiniteNumber(message.completedAt)
    && message.executionId === executionId
    && isNonNegativeSafeInteger(message.runOrdinal)
    && optionalString(message.clientRequestId)
    && isMessageModelAudit(message.modelAudit)
    && (message.compacted === undefined || typeof message.compacted === "boolean");
}

function isCommittedUserAttachmentPart(value: unknown): boolean {
  const part = record(value);
  return part !== undefined
    && exact(part, ["type", "id", "attachment", "createdAt"], ["completedAt"])
    && part.type === "attachment"
    && isString(part.id)
    && isAttachmentDescriptor(part.attachment)
    && isFiniteNumber(part.createdAt)
    && optionalFiniteNumber(part.completedAt);
}

function hasValidCommittedUserContent(parts: readonly unknown[]): boolean {
  const attachmentIds: string[] = [];
  let hasText = false;
  for (const value of parts) {
    const part = record(value);
    if (part?.type === "text") {
      hasText ||= typeof part.text === "string" && part.text.trim().length > 0;
      continue;
    }
    if (part?.type === "attachment") {
      const attachment = record(part.attachment);
      if (typeof attachment?.id === "string") attachmentIds.push(attachment.id);
    }
  }
  return (hasText || attachmentIds.length > 0)
    && attachmentIds.length <= MAX_ATTACHMENTS_PER_MESSAGE
    && new Set(attachmentIds).size === attachmentIds.length;
}

function isAttachmentDescriptorArray(value: unknown): boolean {
  return Array.isArray(value)
    && value.length <= MAX_ATTACHMENTS_PER_MESSAGE
    && value.every(isAttachmentDescriptor)
    && new Set(value.map((item) => (item as UnknownRecord).id)).size === value.length;
}

function isAttachmentDescriptor(value: unknown): boolean {
  const descriptor = record(value);
  return descriptor !== undefined
    && exact(descriptor, ["id", "name", "mediaType", "sizeBytes", "kind"])
    && isUuid(descriptor.id)
    && isValidAttachmentName(descriptor.name)
    && isValidAttachmentMediaType(descriptor.mediaType)
    && isNonNegativeInteger(descriptor.sizeBytes)
    && (descriptor.sizeBytes as number) <= MAX_ATTACHMENT_SIZE_BYTES
    && oneOf(descriptor.kind, ["image", "file"]);
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
    && oneOf(requested.mode, ["profile_default", "session_override"])
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
    && oneOf(binding.resolution, ["requested", "session_override", "profile_default"])
    && isString(binding.modelRuntimeRevision);
}

function isExecutionSuspension(value: unknown): boolean {
  const suspension = record(value);
  if (suspension === undefined || typeof suspension.kind !== "string") return false;
  switch (suspension.kind) {
    case "hitl": {
      if (!exact(suspension, ["kind", "toolBatchId", "blockerIds"])
        || !isString(suspension.toolBatchId)
        || !Array.isArray(suspension.blockerIds)
        || !arrayOf(suspension.blockerIds, isString)
        || suspension.blockerIds.length === 0) return false;
      const blockerIds = suspension.blockerIds as string[];
      return new Set(blockerIds).size === blockerIds.length
        && blockerIds.every((id, index) => index === 0 || blockerIds[index - 1]! < id);
    }
    case "child_dependency":
      return exact(suspension, [
        "kind", "toolBatchId", "toolCallId", "childSessionId", "childExecutionId",
      ])
        && isString(suspension.toolBatchId)
        && isString(suspension.toolCallId)
        && isString(suspension.childSessionId)
        && isString(suspension.childExecutionId);
    case "resume_pending":
      return exact(suspension, ["kind", "toolBatchId", "readyAt"])
        && isString(suspension.toolBatchId)
        && isNonNegativeSafeInteger(suspension.readyAt);
    default:
      return false;
  }
}

function isNormalizedUsage(value: unknown): boolean {
  const usage = record(value);
  return usage !== undefined
    && exact(usage, [
      "inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cachedInputTokens",
    ])
    && Object.values(usage).every(isNonNegativeSafeInteger);
}

function isExecutionSettlementInput(value: unknown): boolean {
  const settlement = record(value);
  return settlement !== undefined
    && exact(settlement, ["key", "goalInstanceId"])
    && isString(settlement.key)
    && settlement.key.length > 0
    && (settlement.goalInstanceId === null || isString(settlement.goalInstanceId));
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

/** Every session event that is safe to replay through the shared projection reducer. */
export function isStreamEvent(event: unknown): event is StreamEvent | SessionGoalChangedEvent {
  return isSessionEventPayload(event) && event.type !== "shutdown";
}

export function isGlobalSSEHitlRealtimeEvent(value: unknown): value is GlobalSSEHitlRealtimeEvent {
  const event = record(value);
  if (event === undefined
    || !exact(event, ["type", "projectSlug", "hitlId", "ownerSessionId", "rootSessionId", "createdAt", "payload", "view"])
    || event.type !== "hitl.event"
    || !isString(event.projectSlug)
    || !isString(event.hitlId)
    || !isString(event.ownerSessionId)
    || !isString(event.rootSessionId)
    || !isFiniteNumber(event.createdAt)
    || !isGlobalHitlPayload(event.payload)
    || !isHitlView(event.view)) return false;

  const view = event.view as UnknownRecord;
  return view.hitlId === event.hitlId
    && view.owner !== undefined
    && record(view.owner)?.id === event.ownerSessionId;
}

export function isGlobalSSEHitlSnapshotEvent(value: unknown): value is GlobalSSEHitlSnapshotEvent {
  const event = record(value);
  return event !== undefined
    && exact(event, ["type", "projectSlugs", "entries", "createdAt"])
    && event.type === "hitl.snapshot"
    && Array.isArray(event.projectSlugs)
    && event.projectSlugs.every(isString)
    && isFiniteNumber(event.createdAt)
    && Array.isArray(event.entries)
    && event.entries.every(isGlobalSSEHitlEntry);
}

function isGlobalSSEHitlEntry(value: unknown): boolean {
  const entry = record(value);
  if (entry === undefined
    || !exact(entry, ["projectSlug", "hitlId", "ownerSessionId", "rootSessionId", "view"])
    || !isString(entry.projectSlug)
    || !isString(entry.hitlId)
    || !isString(entry.ownerSessionId)
    || !isString(entry.rootSessionId)
    || !isHitlView(entry.view)) return false;

  const view = entry.view as UnknownRecord;
  return view.hitlId === entry.hitlId
    && view.owner !== undefined
    && record(view.owner)?.id === entry.ownerSessionId;
}

export function isGlobalSSEResourceChangedEvent(value: unknown): value is GlobalSSEResourceChangedEvent {
  const event = record(value);
  return event !== undefined
    && exact(event, ["type", "projectSlug", "resourceType", "resourceId", "createdAt"])
    && event.type === "resource.changed"
    && isString(event.projectSlug)
    && oneOf(event.resourceType, ["automation", "session", "todo"])
    && isString(event.resourceId)
    && isFiniteNumber(event.createdAt);
}

export function isGlobalSSEUpdateChangedEvent(value: unknown): value is GlobalSSEUpdateChangedEvent {
  const event = record(value);
  return event !== undefined
    && exact(event, ["type", "status", "createdAt"])
    && event.type === "update.changed"
    && isUpdateStatus(event.status)
    && isFiniteNumber(event.createdAt);
}

function isUpdateStatus(value: unknown): value is UpdateStatus {
  const status = record(value);
  if (
    status === undefined
    || !exact(
      status,
      [
        "currentVersion",
        "phase",
        "managed",
        "restartSupported",
        "updateAvailable",
        "restartRequired",
      ],
      ["latest", "lastCheckedAt", "progress", "error"],
    )
    || !isString(status.currentVersion)
    || !oneOf(status.phase, [
      "idle",
      "checking",
      "downloading",
      "verifying",
      "installing",
      "restart_pending",
      "error",
    ])
    || typeof status.managed !== "boolean"
    || typeof status.restartSupported !== "boolean"
    || typeof status.updateAvailable !== "boolean"
    || typeof status.restartRequired !== "boolean"
    || (
      status.lastCheckedAt !== undefined
      && !isNonNegativeSafeInteger(status.lastCheckedAt)
    )
  ) return false;

  const latest = status.latest === undefined ? undefined : record(status.latest);
  if (
    (status.latest !== undefined && latest === undefined)
    || (
      latest !== undefined
      && (
      !exact(latest, ["version", "releaseUrl"])
      || !isString(latest.version)
      || !isString(latest.releaseUrl)
      )
    )
  ) return false;

  const progress = status.progress === undefined ? undefined : record(status.progress);
  if (
    (status.progress !== undefined && progress === undefined)
    || (
      progress !== undefined
      && (
      !exact(progress, ["phase"], ["downloadedBytes", "totalBytes"])
      || !oneOf(progress.phase, ["downloading", "verifying", "installing"])
      || progress.phase !== status.phase
      || (
        progress.downloadedBytes !== undefined
        && !isNonNegativeSafeInteger(progress.downloadedBytes)
      )
      || (
        progress.totalBytes !== undefined
        && !isPositiveSafeInteger(progress.totalBytes)
      )
      || (
        isNonNegativeSafeInteger(progress.downloadedBytes)
        && isPositiveSafeInteger(progress.totalBytes)
        && progress.downloadedBytes > progress.totalBytes
      )
      )
    )
  ) return false;

  const error = status.error === undefined ? undefined : record(status.error);
  return status.error === undefined
    || (
      error !== undefined
      &&
      exact(error, ["code", "message"])
      && isString(error.code)
      && isString(error.message)
    );
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
      ["parentSessionId", "parentToolCallId", "toolName", "childSessionId", "childExecutionId", "childAgentName", "childProfile", "childSkillNames", "title", "depth", "background", "status", "createdAt"],
      ["startedAt", "endedAt", "durationMs", "durationUpdatedAt", "error"],
    )
    && isString(link.parentSessionId) && isString(link.parentToolCallId) && isString(link.toolName)
    && isString(link.childSessionId) && isString(link.childExecutionId) && isString(link.childAgentName)
    && oneOf(link.childProfile, ["principal", "deep", "fast"])
    && Array.isArray(link.childSkillNames) && link.childSkillNames.every(isString)
    && isFiniteNumber(link.depth) && typeof link.background === "boolean"
    && oneOf(link.status, ["linked", "running", "waiting_for_human", "cancelling", "completed", "failed", "timed_out", "cancelled", "interrupted"])
    && isFiniteNumber(link.createdAt) && isString(link.title)
    && optionalFiniteNumber(link.startedAt) && optionalFiniteNumber(link.endedAt)
    && optionalFiniteNumber(link.durationMs)
    && optionalFiniteNumber(link.durationUpdatedAt)
    && (link.durationMs === undefined) === (link.durationUpdatedAt === undefined)
    && optionalString(link.error);
}

export function isFinalizedToolResult(value: unknown): value is FinalizedToolResult {
  const result = record(value);
  return result !== undefined
    && exact(result, ["isError", "output"], ["details"])
    && typeof result.isError === "boolean"
    && isToolOutput(result.output)
    && (result.details === undefined || isToolResultDetails(result.details));
}

function isToolOutput(value: unknown): boolean {
  const output = record(value);
  return output !== undefined
    && exact(output, ["preview", "completeness", "observed", "canonical", "stored", "omitted", "recovery"])
    && isString(output.preview)
    && utf8ByteLength(output.preview) <= 50 * 1024
    && lineCount(output.preview) <= 2_000
    && oneOf(output.completeness, ["complete", "partial"])
    && isToolOutputCount(output.observed)
    && isToolOutputCount(output.canonical)
    && isToolOutputCount(output.stored)
    && isToolOutputCount(output.omitted)
    && isToolOutputRecovery(output.recovery);
}

function isToolOutputCount(value: unknown): boolean {
  const count = record(value);
  return count !== undefined
    && exact(count, ["bytes", "lines"])
    && isNonNegativeSafeInteger(count.bytes)
    && isNonNegativeSafeInteger(count.lines);
}

function isToolOutputRecovery(value: unknown): boolean {
  const recovery = record(value);
  if (recovery === undefined || typeof recovery.kind !== "string") return false;
  if (!hasSerializedUtf8Limit(recovery, 16 * 1024)) return false;
  switch (recovery.kind) {
    case "none":
      return exact(recovery, ["kind"]);
    case "source":
      return exact(recovery, ["kind", "toolName", "nextInput"])
        && isString(recovery.toolName)
        && utf8ByteLength(recovery.toolName) <= 128
        && isBoundedJsonObject(recovery.nextInput);
    case "artifact":
      return exact(recovery, ["kind", "outputRef", "expiresAt", "canRead", "canSearch"])
        && isString(recovery.outputRef)
        && /^[A-Za-z0-9_-]{22}$/.test(recovery.outputRef)
        && isFiniteNumber(recovery.expiresAt)
        && recovery.expiresAt >= 0
        && recovery.canRead === true
        && recovery.canSearch === true;
    default:
      return false;
  }
}

function isToolResultDetails(value: unknown): boolean {
  const details = record(value);
  return details !== undefined
    && exact(details, [], ["error", "process", "unknownResult", "presentations"])
    && (details.error === undefined || isToolResultErrorDetails(details.error))
    && (details.process === undefined || isToolResultProcessDetails(details.process))
    && (details.unknownResult === undefined || details.unknownResult === true)
    && optionalArray(details.presentations, isToolResultPresentation)
    && (!Array.isArray(details.presentations) || details.presentations.length <= 2)
    && hasSerializedUtf8Limit(details, 256 * 1024);
}

function isToolResultErrorDetails(value: unknown): boolean {
  const error = record(value);
  return error !== undefined
    && exact(error, ["kind", "code", "name"], ["hint"])
    && isString(error.kind)
    && utf8ByteLength(error.kind) <= 128
    && isString(error.code)
    && utf8ByteLength(error.code) <= 128
    && isString(error.name)
    && utf8ByteLength(error.name) <= 128
    && optionalString(error.hint)
    && (error.hint === undefined || utf8ByteLength(error.hint as string) <= 2 * 1024);
}

function isToolResultProcessDetails(value: unknown): boolean {
  const process = record(value);
  return process !== undefined
    && exact(process, ["exitCode", "signal", "timedOut", "aborted", "durationMs"])
    && (process.exitCode === null || (isFiniteNumber(process.exitCode) && Number.isInteger(process.exitCode)))
    && (process.signal === null || (isString(process.signal) && utf8ByteLength(process.signal) <= 32))
    && typeof process.timedOut === "boolean"
    && typeof process.aborted === "boolean"
    && isFiniteNumber(process.durationMs)
    && process.durationMs >= 0;
}

function isToolResultPresentation(value: unknown): boolean {
  const presentation = record(value);
  if (presentation === undefined || typeof presentation.kind !== "string") return false;
  switch (presentation.kind) {
    case "diff":
      return exact(presentation, ["kind", "files"], ["simplified", "truncated"])
        && isBoundedDiffPresentationFiles(presentation.files)
        && (presentation.simplified === undefined || presentation.simplified === true)
        && (presentation.truncated === undefined || presentation.truncated === true);
    case "ask_user":
      return exact(presentation, ["kind", "answers"], ["truncated"])
        && isBoundedAskUserPresentations(presentation.answers)
        && (presentation.truncated === undefined || presentation.truncated === true);
    default:
      return false;
  }
}

function isBoundedDiffPresentationFiles(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 20 || !value.every(isDiffFile)) return false;
  let lines = 0;
  for (const file of value) {
    const hunks = record(file)?.hunks;
    if (!Array.isArray(hunks)) return false;
    for (const hunk of hunks) {
      const hunkLines = record(hunk)?.lines;
      if (!Array.isArray(hunkLines)) return false;
      lines += hunkLines.length;
      if (lines > 2_000) return false;
    }
  }
  return true;
}

function isBoundedAskUserPresentations(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 3 || !value.every(isAskUserAnswerPresentation)) return false;
  return hasSerializedUtf8Limit(value, 64 * 1024);
}

function isDiffFile(value: unknown): boolean {
  const file = record(value);
  return file !== undefined
    && exact(file, ["path", "hunks"], ["status", "additions", "deletions"])
    && isString(file.path)
    && utf8ByteLength(file.path) <= 4 * 1024
    && (file.status === undefined || oneOf(file.status, ["modified", "created", "deleted"]))
    && (file.additions === undefined || isNonNegativeSafeInteger(file.additions))
    && (file.deletions === undefined || isNonNegativeSafeInteger(file.deletions))
    && arrayOf(file.hunks, isDiffHunk);
}

function isDiffHunk(value: unknown): boolean {
  const hunk = record(value);
  return hunk !== undefined
    && exact(hunk, ["header", "oldStart", "oldLines", "newStart", "newLines", "lines"])
    && isString(hunk.header)
    && utf8ByteLength(hunk.header) <= 4 * 1024
    && isSafeInteger(hunk.oldStart)
    && isNonNegativeSafeInteger(hunk.oldLines)
    && isSafeInteger(hunk.newStart)
    && isNonNegativeSafeInteger(hunk.newLines)
    && arrayOf(hunk.lines, isDiffLine);
}

function isDiffLine(value: unknown): boolean {
  const line = record(value);
  return line !== undefined
    && exact(line, ["type", "content"])
    && oneOf(line.type, ["context", "add", "delete"])
    && isString(line.content)
    && utf8ByteLength(line.content) <= 4 * 1024;
}

function isAskUserAnswerPresentation(value: unknown): boolean {
  const answer = record(value);
  return answer !== undefined
    && exact(answer, ["question", "answers"])
    && isString(answer.question)
    && utf8ByteLength(answer.question) <= 2 * 1024
    && arrayOf(answer.answers, (item) => isString(item) && utf8ByteLength(item) <= 16 * 1024);
}

function isBoundedJsonObject(value: unknown): boolean {
  const budget = { keys: 0, items: 0 };
  return isBoundedJsonValue(value, 1, budget) && record(value) !== undefined;
}

function isBoundedJsonValue(
  value: unknown,
  depth: number,
  budget: { keys: number; items: number },
): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return utf8ByteLength(value) <= 8 * 1024;
  if (Array.isArray(value)) {
    budget.items += value.length;
    return budget.items <= 256
      && value.every((item) => isBoundedJsonValue(item, depth + 1, budget));
  }
  const object = record(value);
  if (object === undefined) return false;
  const entries = Object.entries(object);
  budget.keys += entries.length;
  return budget.keys <= 64
    && entries.every(([key, item]) => utf8ByteLength(key) <= 128
      && isBoundedJsonValue(item, depth + 1, budget));
}

function isReminder(value: unknown): boolean {
  const reminder = record(value);
  if (!(reminder !== undefined
    && exact(reminder, ["id", "source", "delivery", "content", "createdAt", "consumedAt"], ["sessionId", "terminalState", "payload", "targetSessionId"])
    && isString(reminder.id) && isReminderSource(reminder.source)
    && oneOf(reminder.delivery, ["auto_inject", "on_demand", "model_context"])
    && optionalString(reminder.sessionId) && optionalString(reminder.terminalState)
    && isString(reminder.content) && isFiniteNumber(reminder.createdAt)
    && (reminder.consumedAt === null || isFiniteNumber(reminder.consumedAt))
    && optionalString(reminder.targetSessionId))) return false;
  const source = record(reminder.source);
  const isGoal = source?.type === "session_goal_changed";
  if ((reminder.delivery === "model_context") !== isGoal) return false;
  if (isGoal) {
    const notice = record(source.notice);
    if (notice?.id !== reminder.id) return false;
  }
  return true;
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
  if (source.type === "session_goal_changed") {
    return exact(source, ["type", "notice"]) && isGoalNoticePart(source.notice);
  }
  return false;
}

function isGoalNoticePart(value: unknown): boolean {
  const notice = record(value);
  if (notice === undefined) return false;
  const hasPreviousGeneration = notice.previousGeneration !== undefined;
  if (!exact(
    notice,
    ["type", "id", "action", "authority", "instanceId", "generation", "goal", "createdAt"],
    ["previousGeneration"],
  )) return false;
  if (notice.type !== "goal-notice"
    || !isUuid(notice.id)
    || !oneOf(notice.action, [
      "created",
      "edited",
      "paused",
      "resumed",
      "cleared",
      "budget_updated",
      "budget_limited",
      "blocked",
      "completed",
    ])
    || !oneOf(notice.authority, ["user_control", "agent", "runtime"])
    || !isUuid(notice.instanceId)
    || !isPositiveSafeInteger(notice.generation)
    || !isNonNegativeSafeInteger(notice.createdAt)
    || (hasPreviousGeneration && !isPositiveSafeInteger(notice.previousGeneration))) {
    return false;
  }
  if ((notice.action === "edited") !== hasPreviousGeneration) return false;
  if (notice.action === "edited" && notice.generation !== (notice.previousGeneration as number) + 1) return false;
  if (notice.action === "created" && notice.generation !== 1) return false;
  if ((notice.action === "cleared") !== (notice.goal === null)) return false;
  const expectedAuthority = notice.action === "budget_limited"
    ? "runtime"
    : notice.action === "blocked" || notice.action === "completed"
      ? "agent"
      : "user_control";
  if (notice.authority !== expectedAuthority) return false;
  if (notice.goal !== null) {
    const goal = record(notice.goal);
    const allowedStatuses: readonly unknown[] = notice.action === "created" || notice.action === "resumed"
      ? ["active"]
      : notice.action === "paused"
        ? ["paused", "budget_limited"]
        : notice.action === "budget_limited"
          ? ["budget_limited"]
          : notice.action === "blocked"
            ? ["blocked"]
            : notice.action === "completed"
              ? ["complete"]
              : ["active", "paused", "blocked", "budget_limited", "complete"];
    if (!allowedStatuses.includes(goal?.status)) return false;
  }
  return notice.goal === null || isGoalNoticeSnapshot(notice.goal);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^(?:00000000-0000-0000-0000-000000000000|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.test(value);
}

function isGoalNoticeSnapshot(value: unknown): boolean {
  const goal = record(value);
  if (goal === undefined
    || !exact(goal, ["objective", "status"], ["tokenBudget", "blockedReason"])
    || !isString(goal.objective)
    || goal.objective.trim().length === 0
    || goal.objective.length > SESSION_GOAL_OBJECTIVE_MAX_LENGTH
    || !oneOf(goal.status, ["active", "paused", "blocked", "budget_limited", "complete"])
    || (goal.tokenBudget !== undefined && !isPositiveSafeInteger(goal.tokenBudget))
    || !optionalString(goal.blockedReason)
    || (typeof goal.blockedReason === "string"
      && (goal.blockedReason.trim().length === 0
        || goal.blockedReason.length > SESSION_GOAL_BLOCKED_REASON_MAX_LENGTH))) {
    return false;
  }
  if (goal.status === "blocked" && goal.blockedReason === undefined) return false;
  return goal.blockedReason === undefined || goal.status === "blocked" || goal.status === "budget_limited";
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

function isCompressionSummary(value: unknown): boolean {
  const summary = record(value);
  return summary !== undefined
    && exact(summary, ["sections"])
    && (() => {
      const sections = record(summary.sections);
      return sections !== undefined
        && exact(sections, COMPRESSION_SUMMARY_SECTION_NAMES)
        && COMPRESSION_SUMMARY_SECTION_NAMES.every((section) => isString(sections[section]))
        && isMaterializedCompressionSummarySnapshot(summary as unknown as CompressionSummarySnapshot);
    })();
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
    && isCompressionRange(block.range) && isCompressionSummary(block.summary)
    && arrayOf(block.childBlockRefs, isBlockRef)
    && new Set(block.childBlockRefs as string[]).size === (block.childBlockRefs as string[]).length
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
    && owner.type === "session" && isString(owner.id);
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
    case "cancel":
      return exact(response, ["type", "reason"], ["cancelledBy"])
        && isString(response.reason) && optionalString(response.cancelledBy);
    default:
      return false;
  }
}

/** Session Goal changes are replayed by both server and browser stores. */
function isSessionGoalSnapshot(value: unknown): boolean {
  const goal = record(value);
  if (goal === undefined || !exact(goal, [
    "instanceId", "generation", "objective", "status", "usage", "settlementReceipts",
    "createdAt", "activatedAt", "updatedAt",
  ], [
    "tokenBudget", "blockedReason", "pausedAt", "completedAt",
  ])) return false;

  const usage = record(goal.usage);
  const tokens = usage === undefined ? undefined : record(usage.tokens);
  return isString(goal.instanceId)
    && isPositiveSafeInteger(goal.generation)
    && isString(goal.objective) && goal.objective.trim().length > 0
    && oneOf(goal.status, ["active", "paused", "blocked", "budget_limited", "complete"])
    && (goal.tokenBudget === undefined || isPositiveSafeInteger(goal.tokenBudget))
    && usage !== undefined
    && exact(usage, ["tokens", "executionTimeMs", "executionCount"])
    && tokens !== undefined
    && exact(tokens, ["inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cachedInputTokens"])
    && Object.values(tokens).every(isNonNegativeSafeInteger)
    && isNonNegativeSafeInteger(usage.executionTimeMs)
    && isNonNegativeSafeInteger(usage.executionCount)
    && arrayOf(goal.settlementReceipts, isString)
    && new Set(goal.settlementReceipts as string[]).size === (goal.settlementReceipts as string[]).length
    && isNonNegativeSafeInteger(goal.createdAt)
    && isNonNegativeSafeInteger(goal.activatedAt)
    && isNonNegativeSafeInteger(goal.updatedAt)
    && (goal.pausedAt === undefined || isNonNegativeSafeInteger(goal.pausedAt))
    && (goal.completedAt === undefined || isNonNegativeSafeInteger(goal.completedAt))
    && optionalString(goal.blockedReason);
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function optionalRecord(value: unknown): boolean {
  return value === undefined || record(value) !== undefined;
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

function isNonBlankString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
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

function isNonNegativeSafeInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && Number.isSafeInteger(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isSafeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value);
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasSerializedUtf8Limit(value: unknown, maxBytes: number): boolean {
  try {
    return utf8ByteLength(JSON.stringify(value)) <= maxBytes;
  } catch {
    return false;
  }
}

function lineCount(value: string): number {
  if (value.length === 0) return 0;
  let lines = 1;
  for (const character of value) if (character === "\n") lines += 1;
  return lines;
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
