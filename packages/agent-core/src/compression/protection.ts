import type { CompressionRange, MessageRef, ProtectedRef } from "./types";
import type { SessionStoreState, StoredMessage, StoredPart, ToolChildSessionLink } from "../store/types";

export interface CompressionProtectionResult {
  readonly ok: boolean;
  readonly protectedRefs: ProtectedRef[];
}

export function collectProtectedRefsForRange(
  state: Pick<SessionStoreState, "messages" | "pendingInteractions" | "reminders" | "todos" | "childSessionLinks" | "events">,
  range: CompressionRange,
): CompressionProtectionResult {
  const protectedRefs: ProtectedRef[] = [];
  const messages = state.messages.slice(range.startIndex, range.endIndex + 1);
  const linksByToolCallId = childLinksByToolCallId(state.childSessionLinks);

  for (let offset = 0; offset < messages.length; offset += 1) {
    const message = messages[offset]!;
    const ref = messageRef(range.startIndex + offset);
    collectMessageProtectedRefs(protectedRefs, message, ref, linksByToolCallId);
  }

  collectLatestTailRefs(protectedRefs, state.messages, range);
  collectActiveInteractionRefs(protectedRefs, state, range.startRef);
  collectTodoRefs(protectedRefs, state, range.startRef);
  collectReminderRefs(protectedRefs, state, range.startRef);

  return { ok: protectedRefs.length === 0, protectedRefs };
}

function collectMessageProtectedRefs(
  protectedRefs: ProtectedRef[],
  message: StoredMessage,
  ref: MessageRef,
  linksByToolCallId: ReadonlyMap<string, ToolChildSessionLink[]>,
): void {
  for (const part of message.parts) {
    if (part.type === "tool") {
      if (part.state === "pending") {
        protectedRefs.push(protectedRef(ref, "pending_tool", "Pending tool calls cannot be compressed", message.id, part.id));
      }
      if (part.state === "running") {
        protectedRefs.push(protectedRef(ref, "running_tool", "Running tool calls cannot be compressed", message.id, part.id));
      }
      if (part.state === "error" && part.meta?.unknownResult === true) {
        protectedRefs.push(protectedRef(ref, "unknown_result", "Unknown tool results must remain visible", message.id, part.id));
      }
      if (linksByToolCallId.has(part.toolCallId)) {
        protectedRefs.push(protectedRef(ref, "subagent_link", "Delegated child-session links must remain visible", message.id, part.id));
      }
      continue;
    }

    if (partHasProtectTag(part)) {
      protectedRefs.push(protectedRef(ref, "protect_tag", "Content inside <protect> tags cannot be compressed", message.id, part.id));
    }
  }
}

function collectLatestTailRefs(
  protectedRefs: ProtectedRef[],
  messages: readonly StoredMessage[],
  range: CompressionRange,
): void {
  const tailStartIndex = Math.max(0, messages.length - 2);
  for (let index = Math.max(range.startIndex, tailStartIndex); index <= range.endIndex; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    protectedRefs.push(protectedRef(
      messageRef(index),
      "latest_tail",
      "Latest transcript tail must remain visible for model-callable compression",
      message.id,
    ));
  }
}

function collectActiveInteractionRefs(
  protectedRefs: ProtectedRef[],
  state: Pick<SessionStoreState, "pendingInteractions" | "events">,
  fallbackRef: MessageRef,
): void {
  for (const interaction of state.pendingInteractions ?? []) {
    if (interaction.status === "pending") {
      protectedRefs.push(protectedRef(fallbackRef, "active_question", `Active question ${interaction.id} is pending`));
    }
  }

  for (const permissionId of activePermissionIds(state.events ?? [])) {
    protectedRefs.push(protectedRef(fallbackRef, "active_permission", `Active permission ${permissionId} is pending`));
  }
}

function collectTodoRefs(
  protectedRefs: ProtectedRef[],
  state: Pick<SessionStoreState, "todos">,
  fallbackRef: MessageRef,
): void {
  const activeTodos = state.todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
  if (activeTodos.length > 0) {
    protectedRefs.push(protectedRef(fallbackRef, "todo", `Active todos are pending: ${activeTodos.map((todo) => todo.id).join(", ")}`));
  }
}

function collectReminderRefs(
  protectedRefs: ProtectedRef[],
  state: Pick<SessionStoreState, "reminders">,
  fallbackRef: MessageRef,
): void {
  const unconsumed = state.reminders.filter((reminder) => reminder.consumedAt === null);
  if (unconsumed.length > 0) {
    protectedRefs.push(protectedRef(fallbackRef, "reminder", `Unconsumed reminders are pending: ${unconsumed.map((r) => r.id).join(", ")}`));
  }
}

function partHasProtectTag(part: StoredPart): boolean {
  if (part.type !== "text" && part.type !== "reasoning") return false;
  return /<protect>[\s\S]*?<\/protect>/i.test(part.text) || /<protect\b/i.test(part.text);
}

function childLinksByToolCallId(links: readonly ToolChildSessionLink[]): Map<string, ToolChildSessionLink[]> {
  const map = new Map<string, ToolChildSessionLink[]>();
  for (const link of links) {
    const existing = map.get(link.parentToolCallId) ?? [];
    existing.push(link);
    map.set(link.parentToolCallId, existing);
  }
  return map;
}

function activePermissionIds(events: readonly SessionStoreState["events"][number][]): string[] {
  const active = new Set<string>();
  for (const event of events) {
    const payload = event.payload;
    if (payload.type === "permission.request") active.add(payload.permissionId);
    if (payload.type === "permission.terminal") active.delete(payload.permissionId);
  }
  return [...active];
}

function protectedRef(
  ref: MessageRef,
  kind: ProtectedRef["kind"],
  reason: string,
  messageId?: string,
  partId?: string,
): ProtectedRef {
  return {
    ref,
    kind,
    reason,
    ...(messageId === undefined ? {} : { messageId }),
    ...(partId === undefined ? {} : { partId }),
  };
}

function messageRef(index: number): MessageRef {
  return `m${String(index + 1).padStart(4, "0")}`;
}
