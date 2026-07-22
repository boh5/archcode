import {
  TOOL_DELEGATE,
  type AgentDescriptor,
  type CompressionBlockPart,
  type CompressionBlockSnapshot,
  type CompressionStateSnapshot,
  type ProfileName,
  type SessionExecutionRecord,
  type SessionMessage,
  type ToolChildSessionLink,
} from "@archcode/protocol";

export interface ExecutionWorkstreamInput {
  messages: readonly SessionMessage[];
  executions: readonly SessionExecutionRecord[];
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

export interface ExecutionWorkstreamExecution {
  kind: "execution";
  id: string;
  number: number;
  sortTime: number;
  record: SessionExecutionRecord;
  /** Null when a user_message Execution has no authoritative user text. */
  title: string | null;
  messages: readonly SessionMessage[];
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

function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/u)) {
    const summary = line.trim();
    if (summary.length > 0) return summary;
  }
  return null;
}

function titleForExecution(
  record: SessionExecutionRecord,
  messages: readonly SessionMessage[],
): string | null {
  switch (record.origin) {
    case "goal_continuation":
      return "Continue active goal";
    case "tool_call":
      return "Continue after tool response";
    case "tool_batch":
      return "Continue after tool responses";
    case "user_message": {
      for (const message of messages) {
        if (message.role !== "user") continue;
        for (const part of message.parts) {
          if (part.type !== "text") continue;
          const summary = firstNonEmptyLine(part.text);
          if (summary !== null) return summary;
        }
      }
      return null;
    }
  }
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

  const uniqueRecords = input.executions
    .filter((record) => !duplicateIds.has(record.id))
    .sort(compareExecutionRecords);

  const executions: ExecutionWorkstreamExecution[] = uniqueRecords.map((record, index) => {
    const messages = messagesByExecutionId.get(record.id) ?? [];
    const childSessionLinks = resolveChildLinks(messages, input.childSessionLinks);
    return {
      kind: "execution",
      id: record.id,
      number: index + 1,
      sortTime: record.startedAt,
      record,
      title: titleForExecution(record, messages),
      messages,
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
