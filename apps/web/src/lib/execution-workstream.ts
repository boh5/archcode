import {
  TOOL_DELEGATE,
  type AgentDescriptor,
  type CompressionBlockPart,
  type CompressionBlockSnapshot,
  type CompressionStateSnapshot,
  type ProfileName,
  type SessionExecutionRecord,
  type SessionMessage,
  type SessionPart,
  type SessionStep,
  type TextPart,
  type ToolChildSessionLink,
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

export interface ExecutionWorkstreamMessageSlice {
  /** Authoritative owning message. */
  message: SessionMessage;
  /** Ordered references to the parts that remain inside Work. */
  parts: readonly SessionPart[];
}

export interface ExecutionWorkstreamFinalResponse {
  /** The last Assistant message in the completed Execution. */
  message: SessionMessage;
  /** Ordered, completed, trusted, non-empty Text part references. */
  textParts: readonly TextPart[];
}

export interface ExecutionWorkstreamExecution {
  kind: "execution";
  id: string;
  number: number;
  sortTime: number;
  record: SessionExecutionRecord;
  /** Canonical user inputs remain outside the Work disclosure. */
  userMessages: readonly SessionMessage[];
  /** Every non-input part except the trusted final Text parts. */
  workMessages: readonly ExecutionWorkstreamMessageSlice[];
  /** Absent unless the completed Execution has an authoritative terminal model step. */
  finalResponse?: ExecutionWorkstreamFinalResponse;
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
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameMessageSlices(
  left: readonly ExecutionWorkstreamMessageSlice[],
  right: readonly ExecutionWorkstreamMessageSlice[],
): boolean {
  return left.length === right.length && left.every((slice, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && slice.message === candidate.message
      && sameReferences(slice.parts, candidate.parts);
  });
}

function sameFinalResponse(
  left: ExecutionWorkstreamFinalResponse | undefined,
  right: ExecutionWorkstreamFinalResponse | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.message === right.message && sameReferences(left.textParts, right.textParts);
}

function sameExecutionProjection(
  left: ExecutionWorkstreamExecution,
  right: ExecutionWorkstreamExecution,
): boolean {
  return left.id === right.id
    && left.number === right.number
    && left.sortTime === right.sortTime
    && left.record === right.record
    && left.stepCount === right.stepCount
    && left.toolCount === right.toolCount
    && left.childCount === right.childCount
    && sameReferences(left.userMessages, right.userMessages)
    && sameMessageSlices(left.workMessages, right.workMessages)
    && sameFinalResponse(left.finalResponse, right.finalResponse)
    && sameReferences(left.childSessionLinks, right.childSessionLinks);
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

  const previousExecutions = new Map(previous.executions.map((execution) => [execution.id, execution]));
  const executions = next.executions.map((execution) => {
    const candidate = previousExecutions.get(execution.id);
    return candidate && sameExecutionProjection(candidate, execution) ? candidate : execution;
  });
  const executionById = new Map(executions.map((execution) => [execution.id, execution]));
  const previousItems = new Map(previous.items.map((item) => [`${item.kind}\u0000${item.id}`, item]));
  const items = next.items.map((item) => {
    if (item.kind === "execution") return executionById.get(item.id) ?? item;
    const candidate = previousItems.get(`${item.kind}\u0000${item.id}`);
    if (item.kind === "activity-message" && candidate?.kind === "activity-message") {
      return candidate.message === item.message ? candidate : item;
    }
    if (item.kind === "compression" && candidate?.kind === "compression") {
      return candidate.snapshot === item.snapshot ? candidate : item;
    }
    return item;
  });
  const session = previous.session.agentName === next.session.agentName
    && previous.session.profile === next.session.profile
    && previous.session.displayName === next.session.displayName
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
  left: SessionExecutionRecord,
  right: SessionExecutionRecord,
): number {
  return left.startedAt - right.startedAt || compareStrings(left.id, right.id);
}

function compareSortableItems(left: SortableItem, right: SortableItem): number {
  return left.item.sortTime - right.item.sortTime
    || left.rank - right.rank
    || compareStrings(left.identity, right.identity)
    || left.sourceIndex - right.sourceIndex;
}

function isCanonicalUserMessage(message: SessionMessage): boolean {
  return message.role === "user" && message.parts.some((part) => part.type === "text");
}

function isTrustedFinalTextPart(part: SessionPart): part is TextPart {
  return part.type === "text"
    && part.completedAt !== undefined
    && part.text.trim().length > 0
    && part.meta?.interrupted !== true
    && part.meta?.discardedFromContext !== true;
}

function finalResponseForExecution(
  record: SessionExecutionRecord,
  messages: readonly SessionMessage[],
  steps: readonly SessionStep[],
): ExecutionWorkstreamFinalResponse | undefined {
  if (record.status !== "completed") return undefined;

  const terminalStep = steps.at(-1);
  if (
    terminalStep?.completedAt === undefined
    || terminalStep.finishReason === undefined
    || terminalStep.finishReason === "tool-calls"
    || terminalStep.finishReason === "interrupted"
    || terminalStep.finishReason === "error"
  ) {
    return undefined;
  }

  let message: SessionMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role !== "assistant") continue;
    message = candidate;
    break;
  }
  if (message?.completedAt === undefined) return undefined;

  const textParts = message.parts.filter(isTrustedFinalTextPart);
  return textParts.length === 0 ? undefined : { message, textParts };
}

function splitExecutionMessages(
  messages: readonly SessionMessage[],
  finalResponse: ExecutionWorkstreamFinalResponse | undefined,
): {
  userMessages: readonly SessionMessage[];
  workMessages: readonly ExecutionWorkstreamMessageSlice[];
} {
  const userMessages: SessionMessage[] = [];
  const workMessages: ExecutionWorkstreamMessageSlice[] = [];
  const finalTextParts = new Set<SessionPart>(finalResponse?.textParts ?? []);

  for (const message of messages) {
    if (isCanonicalUserMessage(message)) {
      userMessages.push(message);
      continue;
    }

    const parts = message === finalResponse?.message
      ? message.parts.filter((part) => !finalTextParts.has(part))
      : message.parts;
    if (parts.length > 0) workMessages.push({ message, parts });
  }

  return { userMessages, workMessages };
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
  const stepsByExecutionId = new Map<string, Array<{ step: SessionStep; sourceIndex: number }>>();
  const duplicateMessagesById = new Map<string, SessionMessage[]>();
  const diagnostics: ExecutionWorkstreamDiagnostic[] = [];
  const sortableItems: SortableItem[] = [];

  input.messages.forEach((message, sourceIndex) => {
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
    if (step.executionId === undefined || duplicateIds.has(step.executionId)) return;
    if (!recordsById.has(step.executionId)) return;
    const steps = stepsByExecutionId.get(step.executionId);
    const indexedStep = { step, sourceIndex };
    if (steps) steps.push(indexedStep);
    else stepsByExecutionId.set(step.executionId, [indexedStep]);
  });

  const uniqueRecords = input.executions
    .filter((record) => !duplicateIds.has(record.id))
    .sort(compareExecutionRecords);

  const executions: ExecutionWorkstreamExecution[] = uniqueRecords.map((record, index) => {
    const messages = messagesByExecutionId.get(record.id) ?? [];
    const steps = (stepsByExecutionId.get(record.id) ?? [])
      .sort((left, right) =>
        left.step.step - right.step.step
        || left.step.startedAt - right.step.startedAt
        || left.sourceIndex - right.sourceIndex
      )
      .map(({ step }) => step);
    const finalResponse = finalResponseForExecution(record, messages, steps);
    const { userMessages, workMessages } = splitExecutionMessages(messages, finalResponse);
    const childSessionLinks = resolveChildLinks(messages, input.childSessionLinks);
    return {
      kind: "execution",
      id: record.id,
      number: index + 1,
      sortTime: record.startedAt,
      record,
      userMessages,
      workMessages,
      ...(finalResponse === undefined ? {} : { finalResponse }),
      stepCount: steps.length,
      toolCount: countTools(messages),
      childCount: childSessionLinks.length,
      childSessionLinks,
    };
  });

  executions.forEach((item, sourceIndex) => {
    sortableItems.push({
      item,
      rank: ITEM_RANK[item.kind],
      identity: item.id,
      sourceIndex,
    });
  });

  const compressionBlocks = Object.values(input.compression?.blocksByRef ?? {})
    .sort((left, right) => left.createdAt - right.createdAt || compareStrings(left.ref, right.ref));
  compressionBlocks.forEach((snapshot, sourceIndex) => {
    const block: CompressionBlockPart = {
      type: "compression-block",
      id: `compression:${snapshot.ref}:${snapshot.id}`,
      blockRef: snapshot.ref,
      status: snapshot.status,
      strategy: snapshot.strategy,
      trigger: snapshot.trigger,
      summary: snapshot.summary,
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
