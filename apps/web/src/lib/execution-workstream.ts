import {
  TOOL_DELEGATE,
  renderCompressionSummarySnapshot,
  type AgentDescriptor,
  type AssistantSessionPart,
  type AssistantOutputPart,
  type CompressionBlockPart,
  type CompressionBlockSnapshot,
  type CompressionStateSnapshot,
  type ProfileName,
  type SessionExecutionRecord,
  type SessionMessage,
  type SessionPart,
  type SessionStep,
  type ToolChildSessionLink,
  type UserSessionPart,
} from "@archcode/protocol";

export interface ExecutionWorkstreamInput {
  messages: readonly SessionMessage[];
  executions: readonly SessionExecutionRecord[];
  steps: readonly SessionStep[];
  childSessionLinks: readonly ToolChildSessionLink[];
  compression?: CompressionStateSnapshot;
  session: {
    agentName: string;
    profile: ProfileName;
  };
  agentDescriptors: readonly AgentDescriptor[];
}

export interface WorkstreamSessionIdentity {
  agentName: string;
  profile: ProfileName;
  /** Absent when the authoritative Agent catalog has no matching descriptor. */
  displayName?: string;
}

export interface ExecutionWorkstreamFinalResponse {
  /** The Assistant message explicitly committed as final by Runtime. */
  message: SessionMessage;
  /** Ordered output blocks owned by the final-phase message. */
  outputParts: readonly AssistantOutputPart[];
}

export interface ExecutionWorkstreamMessageItem {
  kind: "message";
  /** Authoritative owning message. */
  message: SessionMessage;
  /** Ordered references to parts that remain inside Work. */
  parts: readonly SessionPart[];
}

export interface ExecutionWorkstreamReasoningUsageItem {
  kind: "reasoning-usage";
  id: string;
  stepId: string;
  tokens: number;
}

export type ExecutionWorkstreamWorkItem =
  | ExecutionWorkstreamMessageItem
  | ExecutionWorkstreamReasoningUsageItem;

/**
 * A read-only, Web-only slice of one logical Execution.  Its boundaries are
 * canonical inputs in message-array order; it is not a persisted
 * lifecycle object.
 */
export interface ExecutionWorkstreamSegment {
  id: string;
  executionId: string;
  executionNumber: number;
  inputMessage?: SessionMessage;
  workItems: readonly ExecutionWorkstreamWorkItem[];
  finalResponse?: ExecutionWorkstreamFinalResponse;
  windowStartedAt: number;
  windowEndedAt: number;
  activeDurationMs: number;
}

export interface ExecutionWorkstreamExecution {
  kind: "execution";
  id: string;
  number: number;
  sortTime: number;
  record: SessionExecutionRecord;
  /** Ordered Web display projection; domain ownership remains the Execution. */
  segments: readonly ExecutionWorkstreamSegment[];
  stepCount: number;
  toolCount: number;
  childCount: number;
  /** Only links resolved through delegate Tool parts in this Execution. */
  childSessionLinks: readonly ToolChildSessionLink[];
}

export interface ExecutionWorkstreamActivityMessage {
  kind: "activity-message";
  id: string;
  sortTime: number;
  message: SessionMessage;
}

export interface ExecutionWorkstreamCompression {
  kind: "compression";
  id: string;
  sortTime: number;
  block: CompressionBlockPart;
  snapshot?: CompressionBlockSnapshot;
}

export type ExecutionWorkstreamItem =
  | ExecutionWorkstreamExecution
  | ExecutionWorkstreamActivityMessage
  | ExecutionWorkstreamCompression;

export type ExecutionWorkstreamDiagnostic =
  | {
      code: "orphan_message";
      message: SessionMessage;
    }
  | {
      code: "unknown_execution";
      executionId: string;
      message: SessionMessage;
    }
  | {
      code: "duplicate_execution";
      executionId: string;
      records: readonly SessionExecutionRecord[];
      messages: readonly SessionMessage[];
    };

export interface ExecutionWorkstreamProjection {
  /** Executions and valid Session-level activity in their authoritative order. */
  items: readonly ExecutionWorkstreamItem[];
  executions: readonly ExecutionWorkstreamExecution[];
  diagnostics: readonly ExecutionWorkstreamDiagnostic[];
  session: WorkstreamSessionIdentity;
  compression?: CompressionStateSnapshot;
}

function sameReferences<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameWorkItems(
  left: readonly ExecutionWorkstreamWorkItem[],
  right: readonly ExecutionWorkstreamWorkItem[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const candidate = right[index];
      if (candidate === undefined || item.kind !== candidate.kind) return false;
      if (item.kind === "reasoning-usage") {
        return (
          candidate.kind === "reasoning-usage" &&
          item.id === candidate.id &&
          item.stepId === candidate.stepId &&
          item.tokens === candidate.tokens
        );
      }
      return (
        candidate.kind === "message" &&
        item.message === candidate.message &&
        sameReferences(item.parts, candidate.parts)
      );
    })
  );
}

function sameFinalResponse(
  left: ExecutionWorkstreamFinalResponse | undefined,
  right: ExecutionWorkstreamFinalResponse | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.message === right.message &&
    sameReferences(left.outputParts, right.outputParts)
  );
}

function sameSegment(
  left: ExecutionWorkstreamSegment,
  right: ExecutionWorkstreamSegment,
): boolean {
  return (
    left.id === right.id &&
    left.windowStartedAt === right.windowStartedAt &&
    left.windowEndedAt === right.windowEndedAt &&
    left.activeDurationMs === right.activeDurationMs &&
    left.inputMessage === right.inputMessage &&
    sameWorkItems(left.workItems, right.workItems) &&
    sameFinalResponse(left.finalResponse, right.finalResponse)
  );
}

function sameExecutionProjection(
  left: ExecutionWorkstreamExecution,
  right: ExecutionWorkstreamExecution,
): boolean {
  return (
    left.id === right.id &&
    left.number === right.number &&
    left.sortTime === right.sortTime &&
    left.record === right.record &&
    left.stepCount === right.stepCount &&
    left.toolCount === right.toolCount &&
    left.childCount === right.childCount &&
    left.segments.length === right.segments.length &&
    left.segments.every((segment, index) => {
      const candidate = right.segments[index];
      return candidate !== undefined && sameSegment(segment, candidate);
    }) &&
    sameReferences(left.childSessionLinks, right.childSessionLinks)
  );
}

/**
 * Reuses unchanged projection objects across streaming snapshots. The builder
 * remains a pure full projection, while React can memoize historical turns by
 * identity instead of reconciling their Markdown and Tool subtrees on every
 * active-Execution delta.
 */
export function stabilizeExecutionWorkstreamProjection(
  previous: ExecutionWorkstreamProjection | undefined,
  next: ExecutionWorkstreamProjection,
): ExecutionWorkstreamProjection {
  if (previous === undefined) return next;

  const previousExecutions = new Map(
    previous.executions.map((execution) => [execution.id, execution]),
  );
  const executions = next.executions.map((execution) => {
    const candidate = previousExecutions.get(execution.id);
    return candidate && sameExecutionProjection(candidate, execution)
      ? candidate
      : execution;
  });
  const executionById = new Map(
    executions.map((execution) => [execution.id, execution]),
  );
  const previousItems = new Map(
    previous.items.map((item) => [`${item.kind}\u0000${item.id}`, item]),
  );
  const items = next.items.map((item) => {
    if (item.kind === "execution") return executionById.get(item.id) ?? item;
    const candidate = previousItems.get(`${item.kind}\u0000${item.id}`);
    if (
      item.kind === "activity-message" &&
      candidate?.kind === "activity-message"
    ) {
      return candidate.message === item.message ? candidate : item;
    }
    if (item.kind === "compression" && candidate?.kind === "compression") {
      return candidate.snapshot === item.snapshot ? candidate : item;
    }
    return item;
  });
  const session =
    previous.session.agentName === next.session.agentName &&
    previous.session.profile === next.session.profile &&
    previous.session.displayName === next.session.displayName
      ? previous.session
      : next.session;

  return {
    ...next,
    items,
    executions,
    session,
  };
}

interface SortableItem {
  item: ExecutionWorkstreamItem;
  rank: number;
  identity: string;
  sourceIndex: number;
}

const ITEM_RANK = {
  execution: 0,
  "activity-message": 1,
  compression: 2,
} as const;

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareExecutionRecords(
  left: { record: SessionExecutionRecord; sourceIndex: number },
  right: { record: SessionExecutionRecord; sourceIndex: number },
): number {
  return (
    left.record.startedAt - right.record.startedAt ||
    left.sourceIndex - right.sourceIndex ||
    compareStrings(left.record.id, right.record.id)
  );
}

function compareSortableItems(left: SortableItem, right: SortableItem): number {
  return (
    left.item.sortTime - right.item.sortTime ||
    left.rank - right.rank ||
    left.sourceIndex - right.sourceIndex ||
    compareStrings(left.identity, right.identity)
  );
}

function isCanonicalUserMessage(message: SessionMessage): boolean {
  return (
    message.role === "user" &&
    message.parts.some((part) => part.type === "text" || part.type === "attachment")
  );
}

/** Internal model-context records are never part of the human conversation UI. */
export function isWebVisibleSessionPart(part: SessionPart): boolean {
  switch (part.type) {
    case "goal-notice":
      return false;
    case "text":
    case "attachment":
    case "tool":
    case "compaction":
    case "system-notice":
    case "recovery-notice":
      return true;
    case "assistant-output":
    case "reasoning":
      return part.text.length > 0;
  }
}

function isAssistantOutputPart(
  part: SessionPart,
): part is AssistantOutputPart {
  return part.type === "assistant-output";
}

function finalResponseForExecution(
  messages: readonly SessionMessage[],
): ExecutionWorkstreamFinalResponse | undefined {
  let message: SessionMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (
      candidate?.role === "assistant" &&
      candidate.outputPhase === "final_answer"
    ) {
      message = candidate;
      break;
    }
  }
  if (message === undefined) return undefined;
  const outputParts = message.parts.filter(isAssistantOutputPart);
  return outputParts.length === 0 ? undefined : { message, outputParts };
}

function messageBoundary(message: SessionMessage): number {
  if (message.completedAt !== undefined) return message.completedAt;
  let boundary = message.createdAt;
  for (const part of message.parts) {
    if ("completedAt" in part && part.completedAt !== undefined)
      boundary = Math.max(boundary, part.completedAt);
    else if ("createdAt" in part) boundary = Math.max(boundary, part.createdAt);
  }
  return boundary;
}

interface MutableSegment {
  id: string;
  inputMessage?: SessionMessage;
  workItems: ExecutionWorkstreamWorkItem[];
  windowStartedAt: number;
}

function executionRunIntervals(
  record: SessionExecutionRecord,
  snapshotNow: number,
): readonly { startedAt: number; endedAt: number }[] {
  return record.runs.map((run) => ({
    startedAt: run.startedAt,
    endedAt: Math.max(run.startedAt, run.endedAt ?? snapshotNow),
  }));
}

function activeDurationInWindow(
  runs: readonly { startedAt: number; endedAt: number }[],
  windowStartedAt: number,
  windowEndedAt: number,
): number {
  return runs.reduce(
    (total, run) =>
      total +
      Math.max(
        0,
        Math.min(run.endedAt, windowEndedAt) -
          Math.max(run.startedAt, windowStartedAt),
      ),
    0,
  );
}

function projectExecutionSegments(
  record: SessionExecutionRecord,
  messages: readonly SessionMessage[],
  steps: readonly SessionStep[],
  finalResponse: ExecutionWorkstreamFinalResponse | undefined,
  executionNumber: number,
  snapshotNow: number,
): readonly ExecutionWorkstreamSegment[] {
  const segments: MutableSegment[] = [];
  const finalOutputParts = new Set<SessionPart>(
    finalResponse?.outputParts ?? [],
  );
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  let current: MutableSegment | undefined;
  let previousBoundary = record.startedAt;

  const openImplicit = () => {
    if (current) return current;
    current = {
      id: `work:${record.id}:implicit`,
      workItems: [],
      windowStartedAt: previousBoundary,
    };
    segments.push(current);
    return current;
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message && isCanonicalUserMessage(message)) {
      const boundary = Math.max(previousBoundary, messageBoundary(message));
      const isFirstSegment = segments.length === 0;
      previousBoundary = boundary;
      current = {
        id: `work:${record.id}:after:${message.id}`,
        inputMessage: message,
        workItems: [],
        windowStartedAt: isFirstSegment ? record.startedAt : boundary,
      };
      segments.push(current);
      continue;
    }

    if (!message) continue;
    const nonEmptyParts = message.parts.filter((part) =>
      part.type !== "assistant-output" && part.type !== "reasoning"
        ? true
        : part.text.length > 0
    );
    const visibleParts =
      message === finalResponse?.message
        ? nonEmptyParts.filter((part) => !finalOutputParts.has(part))
        : nonEmptyParts;
    const segment = openImplicit();
    if (message.role === "assistant") {
      const step = stepsById.get(message.stepId);
      const reasoningTokens = Math.max(
        0,
        step?.usage?.reasoningTokens ?? 0,
      );
      const hasReasoningText = message.parts.some(
        (part) =>
          part.type === "reasoning" && part.text.trim().length > 0,
      );
      if (reasoningTokens > 0 && !hasReasoningText) {
        segment.workItems.push({
          kind: "reasoning-usage",
          id: `reasoning-usage:${message.stepId}`,
          stepId: message.stepId,
          tokens: reasoningTokens,
        });
      }
    }
    if (visibleParts.length > 0) {
      segment.workItems.push({
        kind: "message",
        message,
        parts: visibleParts,
      });
    }
  }

  // A terminal response belongs to the final display segment, including an
  // otherwise empty input-only Execution.
  if (finalResponse) openImplicit();
  if (segments.length === 0) openImplicit();

  const terminalBoundary = Math.max(
    previousBoundary,
    record.endedAt ?? snapshotNow,
  );
  const runs = executionRunIntervals(record, snapshotNow);
  return segments.map((segment, index) => {
    const next = segments[index + 1];
    const windowEndedAt = next?.windowStartedAt ?? terminalBoundary;
    return {
      id: segment.id,
      executionId: record.id,
      executionNumber,
      ...(segment.inputMessage
        ? { inputMessage: segment.inputMessage }
        : {}),
      workItems: segment.workItems,
      ...(index === segments.length - 1 && finalResponse
        ? { finalResponse }
        : {}),
      windowStartedAt: segment.windowStartedAt,
      windowEndedAt,
      activeDurationMs: activeDurationInWindow(
        runs,
        segment.windowStartedAt,
        windowEndedAt,
      ),
    };
  });
}

function sessionActivityTime(message: SessionMessage): number | null {
  if (message.parts.length === 0) return null;

  let maximum = Number.NEGATIVE_INFINITY;
  for (const part of message.parts) {
    if (part.type === "system-notice") {
      maximum = Math.max(maximum, part.createdAt);
      continue;
    }
    if (part.type === "compaction") {
      maximum = Math.max(maximum, part.compactedAt);
      continue;
    }
    return null;
  }
  return maximum;
}

function countTools(messages: readonly SessionMessage[]): number {
  let count = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool") count += 1;
    }
  }
  return count;
}

function resolveChildLinks(
  messages: readonly SessionMessage[],
  links: readonly ToolChildSessionLink[],
): readonly ToolChildSessionLink[] {
  const delegateToolCallIds = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool" && part.toolName === TOOL_DELEGATE) {
        delegateToolCallIds.add(part.toolCallId);
      }
    }
  }
  return links.filter((link) => delegateToolCallIds.has(link.parentToolCallId));
}

/**
 * Builds the complete Web-only Execution projection without changing, copying,
 * or inferring ownership for any domain object.
 */
export function buildExecutionWorkstream(
  input: ExecutionWorkstreamInput,
): ExecutionWorkstreamProjection {
  const recordsById = new Map<string, SessionExecutionRecord[]>();
  for (const execution of input.executions) {
    const records = recordsById.get(execution.id);
    if (records) records.push(execution);
    else recordsById.set(execution.id, [execution]);
  }

  const duplicateIds = new Set<string>();
  for (const [id, records] of recordsById) {
    if (records.length > 1) duplicateIds.add(id);
  }

  const messagesByExecutionId = new Map<string, SessionMessage[]>();
  const stepsByExecutionId = new Map<
    string,
    Array<{ step: SessionStep; sourceIndex: number }>
  >();
  const duplicateMessagesById = new Map<string, SessionMessage[]>();
  const diagnostics: ExecutionWorkstreamDiagnostic[] = [];
  const sortableItems: SortableItem[] = [];

  input.messages.forEach((sourceMessage, sourceIndex) => {
    const visibleParts: UserSessionPart[] | AssistantSessionPart[] =
      sourceMessage.role === "user"
        ? sourceMessage.parts.filter(isWebVisibleSessionPart)
        : sourceMessage.parts.filter(isWebVisibleSessionPart);
    const modelStepAnchor = sourceMessage.role === "assistant";
    if (visibleParts.length === 0 && !modelStepAnchor) return;
    const message: SessionMessage =
      visibleParts.length === sourceMessage.parts.length
        ? sourceMessage
        : sourceMessage.role === "user"
          ? { ...sourceMessage, parts: visibleParts as UserSessionPart[] }
          : { ...sourceMessage, parts: visibleParts as AssistantSessionPart[] };
    const executionId = message.executionId;
    if (executionId !== undefined && executionId.length > 0) {
      if (duplicateIds.has(executionId)) {
        const duplicateMessages = duplicateMessagesById.get(executionId);
        if (duplicateMessages) duplicateMessages.push(message);
        else duplicateMessagesById.set(executionId, [message]);
        return;
      }
      if (!recordsById.has(executionId)) {
        diagnostics.push({ code: "unknown_execution", executionId, message });
        return;
      }
      const messages = messagesByExecutionId.get(executionId);
      if (messages) messages.push(message);
      else messagesByExecutionId.set(executionId, [message]);
      return;
    }

    const sortTime = sessionActivityTime(message);
    if (sortTime === null) {
      diagnostics.push({ code: "orphan_message", message });
      return;
    }

    const item: ExecutionWorkstreamActivityMessage = {
      kind: "activity-message",
      id: message.id,
      sortTime,
      message,
    };
    sortableItems.push({
      item,
      rank: ITEM_RANK[item.kind],
      identity: message.id,
      sourceIndex,
    });
  });

  input.steps.forEach((step, sourceIndex) => {
    if (step.executionId === undefined || duplicateIds.has(step.executionId))
      return;
    if (!recordsById.has(step.executionId)) return;
    const steps = stepsByExecutionId.get(step.executionId);
    const indexedStep = { step, sourceIndex };
    if (steps) steps.push(indexedStep);
    else stepsByExecutionId.set(step.executionId, [indexedStep]);
  });

  const uniqueRecords = input.executions
    .map((record, sourceIndex) => ({ record, sourceIndex }))
    .filter(({ record }) => !duplicateIds.has(record.id))
    .sort(compareExecutionRecords)
    .map(({ record }) => record);

  const snapshotNow = Date.now();
  const executions: ExecutionWorkstreamExecution[] = uniqueRecords.map(
    (record, index) => {
      const messages = messagesByExecutionId.get(record.id) ?? [];
      const steps = (stepsByExecutionId.get(record.id) ?? [])
        .sort(
          (left, right) =>
            left.step.step - right.step.step ||
            left.step.startedAt - right.step.startedAt ||
            left.sourceIndex - right.sourceIndex,
        )
        .map(({ step }) => step);
      const finalResponse = finalResponseForExecution(messages);
      const childSessionLinks = resolveChildLinks(
        messages,
        input.childSessionLinks,
      );
      return {
        kind: "execution",
        id: record.id,
        number: index + 1,
        sortTime: record.startedAt,
        record,
        segments: projectExecutionSegments(
          record,
          messages,
          steps,
          finalResponse,
          index + 1,
          snapshotNow,
        ),
        stepCount: steps.length,
        toolCount: countTools(messages),
        childCount: childSessionLinks.length,
        childSessionLinks,
      };
    },
  );

  executions.forEach((item, sourceIndex) => {
    sortableItems.push({
      item,
      rank: ITEM_RANK[item.kind],
      identity: item.id,
      sourceIndex,
    });
  });

  const compressionBlocks = Object.values(
    input.compression?.blocksByRef ?? {},
  ).sort(
    (left, right) =>
      left.createdAt - right.createdAt || compareStrings(left.ref, right.ref),
  );
  compressionBlocks.forEach((snapshot, sourceIndex) => {
    const block: CompressionBlockPart = {
      type: "compression-block",
      id: `compression:${snapshot.ref}:${snapshot.id}`,
      blockRef: snapshot.ref,
      status: snapshot.status,
      strategy: snapshot.strategy,
      trigger: snapshot.trigger,
      summary: renderCompressionSummarySnapshot(snapshot.summary),
      startRef: snapshot.range.startRef,
      endRef: snapshot.range.endRef,
      childBlockRefs: snapshot.childBlockRefs,
      committedAt: snapshot.createdAt,
    };
    const item: ExecutionWorkstreamCompression = {
      kind: "compression",
      id: block.id,
      sortTime: block.committedAt,
      block,
      snapshot,
    };
    sortableItems.push({
      item,
      rank: ITEM_RANK[item.kind],
      identity: block.id,
      sourceIndex,
    });
  });

  const sortedDuplicateIds = [...duplicateIds].sort(compareStrings);
  for (const executionId of sortedDuplicateIds) {
    diagnostics.push({
      code: "duplicate_execution",
      executionId,
      records: recordsById.get(executionId) ?? [],
      messages: duplicateMessagesById.get(executionId) ?? [],
    });
  }

  const descriptor = input.agentDescriptors.find(
    (candidate) => candidate.name === input.session.agentName,
  );
  const session: WorkstreamSessionIdentity = {
    agentName: input.session.agentName,
    profile: input.session.profile,
    ...(descriptor ? { displayName: descriptor.displayName } : {}),
  };

  return {
    items: sortableItems.sort(compareSortableItems).map(({ item }) => item),
    executions,
    diagnostics,
    session,
    compression: input.compression,
  };
}
