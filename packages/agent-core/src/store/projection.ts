import type { ModelMessage } from "ai";
import type { StoredMessage, StoredPart } from "./types";
import { redactValue } from "../tools/security";
import {
  buildMessageRefMap,
  renderCompressionSummary,
  type CompressionBlock,
  type CompressionRefMap,
  type CompressionState,
  type MessageRef,
} from "../compression";

export type ProjectionMode = "model" | "full-history";

export interface ProjectionOptions {
  mode?: ProjectionMode;
  compression?: CompressionState;
}

export interface ModelMessagesProjection {
  readonly messages: ModelMessage[];
  readonly refMap?: CompressionRefMap;
}

type AssistantMessageContent = Extract<ModelMessage, { role: "assistant" }>["content"];
type AssistantContentPart<T> = T extends readonly (infer Part)[] ? Exclude<Part, string> : never;
type AssistantArrayContent = AssistantContentPart<AssistantMessageContent>[];

const INTERRUPTION_RECOVERY_MARKER =
  "<interrupted-response-recovery>\nThe previous assistant response was interrupted. Its partial assistant text was preserved in session history for visibility only and was intentionally omitted from this model context. Do not treat the omitted partial text as completed assistant output; continue from the user's latest request and, if needed, recover by restating only verified context.\n</interrupted-response-recovery>";

export function toModelMessagesFromStoredMessages(
  messages: StoredMessage[],
  options?: ProjectionOptions,
): ModelMessage[] {
  return projectModelMessagesFromStoredMessages(messages, options).messages;
}

export function projectModelMessagesFromStoredMessages(
  messages: StoredMessage[],
  options?: ProjectionOptions,
): ModelMessagesProjection {
  const mode = options?.mode ?? "model";
  const compressionProjection = mode === "model" && options?.compression !== undefined
    ? createCompressionProjection(messages, options.compression)
    : undefined;
  const modelMessages: ModelMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const block = compressionProjection?.blocksByStartIndex.get(index);
    if (block !== undefined) {
      modelMessages.push({ role: "user", content: renderCompressionBlock(block) });
      index = block.range.endIndex;
      continue;
    }

    if (compressionProjection?.coveredIndexes.has(index)) continue;

    if (mode === "model" && message.compacted) {
      continue;
    }

    if (message.role === "user") {
      let content = "";

      for (const part of message.parts) {
        if (mode === "full-history" && part.type === "compaction") {
          continue;
        }
        if (mode === "full-history" && part.type === "system-notice") {
          continue;
        }
        if (part.type === "compaction") {
          content += `<compact-summary>\n${part.summary}\n</compact-summary>`;
          continue;
        }
        if (part.type === "text" && part.completedAt !== undefined && !isDiscardedFromContext(part)) {
          content += part.text;
        }
      }

      if (content.length > 0) {
        modelMessages.push({ role: "user", content: wrapUserContent(content, messageRefFor(message, index, compressionProjection)) });
      }

      continue;
    }

    if (mode === "full-history") {
      const assistantContent: AssistantArrayContent = [];
      const toolContent: Extract<ModelMessage, { role: "tool" }>["content"] = [];

      for (const part of message.parts) {
        if (part.type === "system-notice" || part.type === "recovery-notice") continue;

        if (part.type === "text") {
          if (isDiscardedFromContext(part)) {
            pushRecoveryMarker(modelMessages);
          } else if (part.completedAt !== undefined) {
            assistantContent.push({ type: "text", text: part.text });
          }
          continue;
        }

        if (part.type === "reasoning") {
          continue;
        }

        if (part.type === "compaction") {
          continue;
        }

        if (part.state === "completed") {
          assistantContent.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: redactValue(part.input),
          });
          toolContent.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: { type: "text", value: part.output },
          });
        }

        if (part.state === "error") {
          assistantContent.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: redactValue(part.input),
          });
          toolContent.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: { type: "error-text", value: part.errorMessage },
          });
        }
      }

      if (assistantContent.length > 0) {
        modelMessages.push({ role: "assistant", content: assistantContent });
      }

      if (toolContent.length > 0) {
        modelMessages.push({ role: "tool", content: toolContent });
      }

      continue;
    }

    const assistantContent: AssistantArrayContent = [];
    const toolContent: Extract<ModelMessage, { role: "tool" }>["content"] = [];

    for (const part of message.parts) {
      if (part.type === "text") {
        if (isDiscardedFromContext(part)) {
          pushRecoveryMarker(modelMessages);
        } else if (part.completedAt !== undefined) {
          assistantContent.push({ type: "text", text: part.text });
        }

        continue;
      }

      if (part.type === "reasoning") {
        continue;
      }

      if (part.type === "compaction" || part.type === "system-notice" || part.type === "recovery-notice") {
        continue;
      }

      if (part.state === "completed") {
        assistantContent.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: redactValue(part.input),
        });
        toolContent.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: { type: "text", value: part.output },
        });
      }

      if (part.state === "error") {
        assistantContent.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: redactValue(part.input),
        });
        toolContent.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: { type: "error-text", value: part.errorMessage },
        });
      }
    }

    if (assistantContent.length > 0) {
      modelMessages.push({ role: "assistant", content: wrapAssistantContent(assistantContent, messageRefFor(message, index, compressionProjection)) });
    }

    if (toolContent.length > 0) {
      modelMessages.push({ role: "tool", content: toolContent });
    }
  }

  return {
    messages: modelMessages,
    ...(compressionProjection === undefined ? {} : { refMap: compressionProjection.refMap }),
  };
}

interface CompressionProjection {
  readonly shouldInjectRefs: boolean;
  readonly refMap: CompressionRefMap;
  readonly refsByMessageId: Map<string, MessageRef>;
  readonly blocksByStartIndex: Map<number, CompressionBlock>;
  readonly coveredIndexes: Set<number>;
}

function createCompressionProjection(
  messages: readonly StoredMessage[],
  compression: CompressionState,
): CompressionProjection {
  const refMap = buildMessageRefMap(messages.map((message) => message.id), compression.refMap);
  const refsByMessageId = new Map<string, MessageRef>();
  const shouldInjectRefs = messages.length > 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    refsByMessageId.set(message.id, refMap.messageRefsById[message.id] ?? formatProjectionMessageRef(index + 1));
  }

  const activeBlocks = compression.activeBlockRefs
    .map((ref) => compression.blocksByRef[ref])
    .filter((block): block is CompressionBlock => block !== undefined && block.status === "active")
    .sort((left, right) => left.range.startIndex - right.range.startIndex);

  const blocksByStartIndex = new Map<number, CompressionBlock>();
  const coveredIndexes = new Set<number>();
  for (const block of activeBlocks) {
    blocksByStartIndex.set(block.range.startIndex, block);
    for (let coveredIndex = block.range.startIndex; coveredIndex <= block.range.endIndex; coveredIndex += 1) {
      coveredIndexes.add(coveredIndex);
    }
  }

  return { shouldInjectRefs, refMap, refsByMessageId, blocksByStartIndex, coveredIndexes };
}

function messageRefFor(
  message: StoredMessage,
  index: number,
  projection: CompressionProjection | undefined,
): MessageRef | undefined {
  if (projection?.shouldInjectRefs !== true) return undefined;
  return projection.refsByMessageId.get(message.id) ?? formatProjectionMessageRef(index + 1);
}

function wrapUserContent(content: string, ref: MessageRef | undefined): string {
  if (ref === undefined) return content;
  return `<message ref="${ref}">\n${content}\n</message>`;
}

function wrapAssistantContent(
  content: AssistantArrayContent,
  ref: MessageRef | undefined,
): AssistantArrayContent {
  if (ref === undefined) return content;
  return [
    { type: "text", text: `<message ref="${ref}">` },
    ...content,
    { type: "text", text: "</message>" },
  ];
}

function renderCompressionBlock(block: CompressionBlock): string {
  return `<compression-block ref="${block.ref}" strategy="${block.strategy}" start-ref="${block.range.startRef}" end-ref="${block.range.endRef}">\n${renderCompressionSummary(block.summary)}\n</compression-block>`;
}

function formatProjectionMessageRef(index: number): MessageRef {
  return `m${index.toString().padStart(4, "0")}`;
}

function isDiscardedFromContext(part: StoredPart): boolean {
  if (part.type !== "text" && part.type !== "reasoning") return false;
  return part.meta?.interrupted === true || part.meta?.discardedFromContext === true;
}

function pushRecoveryMarker(modelMessages: ModelMessage[]): void {
  const latest = modelMessages.at(-1);
  if (latest?.role === "system" && latest.content === INTERRUPTION_RECOVERY_MARKER) return;
  modelMessages.push({ role: "system", content: INTERRUPTION_RECOVERY_MARKER });
}
