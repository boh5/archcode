import type { CompressionRange, MessageRef, ProtectedRef } from "./types";
import type { SessionStoreState, StoredMessage, StoredPart } from "../store/types";

export interface CompressionProtectionResult {
  readonly ok: boolean;
  readonly protectedRefs: ProtectedRef[];
}

export function collectProtectedRefsForRange(
  state: Pick<SessionStoreState, "messages">,
  range: CompressionRange,
): CompressionProtectionResult {
  const protectedRefs: ProtectedRef[] = [];
  const messages = state.messages.slice(range.startIndex, range.endIndex + 1);

  for (let offset = 0; offset < messages.length; offset += 1) {
    const message = messages[offset]!;
    const ref = messageRef(range.startIndex + offset);
    collectMessageProtectedRefs(protectedRefs, message, ref);
  }

  collectLatestTailRefs(protectedRefs, state.messages, range);

  return { ok: protectedRefs.length === 0, protectedRefs };
}

function collectMessageProtectedRefs(
  protectedRefs: ProtectedRef[],
  message: StoredMessage,
  ref: MessageRef,
): void {
  for (const part of message.parts) {
    if (part.type === "tool") {
      if (part.state === "pending") {
        protectedRefs.push(protectedRef(ref, "pending_tool", "Pending tool calls cannot be compressed", message.id, part.id));
      }
      if (part.state === "running") {
        protectedRefs.push(protectedRef(ref, "running_tool", "Running tool calls cannot be compressed", message.id, part.id));
      }
      if (part.state === "error" && part.result.details?.unknownResult === true) {
        protectedRefs.push(protectedRef(ref, "unknown_result", "Unknown tool results must remain visible", message.id, part.id));
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

function partHasProtectTag(part: StoredPart): boolean {
  if (part.type !== "assistant-output" && part.type !== "reasoning") return false;
  return /<protect>[\s\S]*?<\/protect>/i.test(part.text) || /<protect\b/i.test(part.text);
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
