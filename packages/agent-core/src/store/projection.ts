import type { ModelMessage } from "ai";
import type { StoredMessage, StoredPart } from "./types";
import type {
  AttachmentDescriptor,
  FinalizedToolResult,
  GoalNoticePart,
  ParentAgentMessageProvenance,
} from "@archcode/protocol";
import { TOOL_OUTPUT_PREVIEW_MAX_BYTES, TOOL_OUTPUT_PREVIEW_MAX_LINES } from "../tool-output/constants";
import { projectCanonicalText } from "../tool-output/projection";
import { utf8ByteLength } from "../tool-output/utf8";
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
  readonly attachmentSlots: AttachmentProjectionSlot[];
}

type UserMessageContent = Extract<ModelMessage, { role: "user" }>["content"];
type UserArrayContent = Exclude<UserMessageContent, string>;
export type AttachmentMarkerPart = Extract<UserArrayContent[number], { type: "text" }>;

export interface AttachmentProjectionSlot {
  readonly markerPart: AttachmentMarkerPart;
  readonly descriptor: AttachmentDescriptor;
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
  const attachmentSlots: AttachmentProjectionSlot[] = [];
  const latestGoalNotice = mode === "model" ? findLatestGoalNotice(messages) : undefined;
  let latestGoalNoticeProjected = false;

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
      const contentParts: UserArrayContent = [];
      let usesArrayContent = false;
      const flushText = () => {
        if (content.length === 0) return;
        contentParts.push({ type: "text", text: content });
        content = "";
      };

      for (const part of message.parts) {
        if (mode === "full-history" && part.type === "compaction") {
          continue;
        }
        if (mode === "full-history" && part.type === "system-notice") {
          continue;
        }
        if (part.type === "goal-notice") {
          if (mode === "model") {
            content += renderGoalNotice(part);
            if (part.id === latestGoalNotice?.id) latestGoalNoticeProjected = true;
          }
          continue;
        }
        if (part.type === "compaction") {
          content += `<compact-summary>\n${part.summary}\n</compact-summary>`;
          continue;
        }
        if (part.type === "attachment" && part.completedAt !== undefined) {
          usesArrayContent = true;
          flushText();
          const markerPart: AttachmentMarkerPart = {
            type: "text",
            text: renderAttachmentMarker(part.attachment),
          };
          contentParts.push(markerPart);
          attachmentSlots.push({
            markerPart,
            descriptor: { ...part.attachment },
          });
          continue;
        }
        if (part.type === "text" && part.completedAt !== undefined && !isDiscardedFromContext(part)) {
          content += part.text;
        }
      }
      if (usesArrayContent) flushText();

      const inputEnvelope = message.inputSource === "parent_agent" && message.parentAgentProvenance !== undefined
        ? {
            open: renderParentAgentInputOpen(message.parentAgentProvenance),
            close: "</parent-agent-message>",
          }
        : message.executionId !== undefined && message.inputSource === undefined
          ? {
              open: '<external-input source="unknown">',
              close: "</external-input>",
            }
          : undefined;
      if (inputEnvelope !== undefined) {
        if (usesArrayContent) {
          contentParts.unshift({ type: "text", text: inputEnvelope.open });
          contentParts.push({ type: "text", text: inputEnvelope.close });
        } else {
          content = [inputEnvelope.open, content, inputEnvelope.close].join("\n");
        }
      }

      if (usesArrayContent && contentParts.length > 0) {
        modelMessages.push({
          role: "user",
          content: wrapUserContent(
            contentParts,
            messageRefFor(message, index, compressionProjection),
          ),
        });
      } else if (content.length > 0) {
        modelMessages.push({
          role: "user",
          content: wrapUserText(
            content,
            messageRefFor(message, index, compressionProjection),
          ),
        });
      }

      continue;
    }

    if (mode === "full-history") {
      const assistantContent: AssistantArrayContent = [];
      const toolContent: Extract<ModelMessage, { role: "tool" }>["content"] = [];

      for (const part of message.parts) {
        if (part.type === "system-notice" || part.type === "recovery-notice") continue;

        if (part.type === "assistant-output") {
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

        if (part.state === "completed") {
          assistantContent.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
          toolContent.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: {
              type: "text",
              value: renderToolResultForModel(part.result, part.toolCallId, part.toolName, "text"),
            },
          });
        }

        if (part.state === "error") {
          assistantContent.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
          toolContent.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: {
              type: "error-text",
              value: renderToolResultForModel(part.result, part.toolCallId, part.toolName, "error-text"),
            },
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
      if (part.type === "assistant-output") {
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

      if (part.type === "system-notice" || part.type === "recovery-notice") {
        continue;
      }

      if (part.state === "completed") {
        assistantContent.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
        toolContent.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: {
            type: "text",
            value: renderToolResultForModel(part.result, part.toolCallId, part.toolName, "text"),
          },
        });
      }

      if (part.state === "error") {
        assistantContent.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
        toolContent.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: {
            type: "error-text",
            value: renderToolResultForModel(part.result, part.toolCallId, part.toolName, "error-text"),
          },
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

  if (latestGoalNotice !== undefined && !latestGoalNoticeProjected) {
    modelMessages.push({
      role: "user",
      content: renderGoalNotice(latestGoalNotice),
    });
  }

  return {
    messages: modelMessages,
    attachmentSlots,
    ...(compressionProjection === undefined ? {} : { refMap: compressionProjection.refMap }),
  };
}

function renderParentAgentInputOpen(
  provenance: ParentAgentMessageProvenance,
): string {
  return [
    "<parent-agent-message>",
    `Sender: ${JSON.stringify(provenance)}`,
  ].join("\n");
}

function findLatestGoalNotice(messages: readonly StoredMessage[]): GoalNoticePart | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]!;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex]!;
      if (part.type === "goal-notice") {
        return part;
      }
    }
  }
  return undefined;
}

function renderGoalNotice(notice: GoalNoticePart): string {
  const lines = [
    "<goal-notice>",
    `<id>${escapeXml(notice.id)}</id>`,
    `<action>${notice.action}</action>`,
    `<authority>${notice.authority}</authority>`,
    `<instance-id>${escapeXml(notice.instanceId)}</instance-id>`,
    ...(notice.previousGeneration === undefined
      ? []
      : [`<previous-generation>${notice.previousGeneration}</previous-generation>`]),
    `<generation>${notice.generation}</generation>`,
    `<created-at>${notice.createdAt}</created-at>`,
  ];

  if (notice.goal === null) {
    lines.push("<goal cleared=\"true\" />");
  } else {
    lines.push(
      "<goal>",
      `<objective>${escapeXml(notice.goal.objective)}</objective>`,
      `<status>${notice.goal.status}</status>`,
      ...(notice.goal.tokenBudget === undefined
        ? []
        : [`<token-budget>${notice.goal.tokenBudget}</token-budget>`]),
      ...(notice.goal.blockedReason === undefined
        ? []
        : [`<blocked-reason>${escapeXml(notice.goal.blockedReason)}</blocked-reason>`]),
      "</goal>",
    );
  }

  lines.push("</goal-notice>");
  return lines.join("\n");
}

export function renderAttachmentMarker(
  descriptor: AttachmentDescriptor,
  contentPath?: string,
): string {
  return [
    "<attachment>",
    `<id>${escapeXml(descriptor.id)}</id>`,
    `<name>${escapeXml(descriptor.name)}</name>`,
    `<media-type>${escapeXml(descriptor.mediaType)}</media-type>`,
    `<size-bytes>${descriptor.sizeBytes}</size-bytes>`,
    `<kind>${descriptor.kind}</kind>`,
    ...(contentPath === undefined ? [] : [`<path>${escapeXml(contentPath)}</path>`]),
    "</attachment>",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
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

function wrapUserContent(content: UserArrayContent, ref: MessageRef | undefined): UserArrayContent {
  if (ref === undefined) return content;
  return [
    { type: "text", text: `<message ref="${ref}">` },
    ...content,
    { type: "text", text: "</message>" },
  ];
}

function wrapUserText(content: string, ref: MessageRef | undefined): string {
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
  if (part.type !== "assistant-output" && part.type !== "reasoning") return false;
  return part.meta?.interrupted === true || part.meta?.discardedFromContext === true;
}

function renderToolResultForModel(
  result: FinalizedToolResult,
  toolCallId: string,
  toolName: string,
  outputType: "text" | "error-text",
): string {
  const visibleDetails = result.details === undefined
    ? undefined
    : {
      ...(result.details.error === undefined ? {} : { error: result.details.error }),
      ...(result.details.process === undefined ? {} : { process: result.details.process }),
      ...(result.details.unknownResult === undefined ? {} : { unknownResult: true as const }),
    };
  const hasVisibleDetails = visibleDetails !== undefined && Object.keys(visibleDetails).length > 0;
  const recovery = result.output.recovery.kind === "artifact"
    ? {
      kind: "artifact" as const,
      outputRef: result.output.recovery.outputRef,
      readTool: "output_read" as const,
      searchTool: "output_search" as const,
    }
    : result.output.recovery;

  const render = (preview: string): string => [
    preview,
    ...(hasVisibleDetails ? [`[tool-result-details] ${JSON.stringify(visibleDetails)}`] : []),
    ...(recovery.kind === "none" ? [] : [`[tool-output-recovery] ${JSON.stringify(recovery)}`]),
  ].filter((section) => section.length > 0).join("\n");
  const serializedBytes = (value: string): number => utf8ByteLength(JSON.stringify({
    type: "tool-result",
    toolCallId,
    toolName,
    output: { type: outputType, value },
  }));

  const complete = render(result.output.preview);
  if (serializedBytes(complete) <= TOOL_OUTPUT_PREVIEW_MAX_BYTES) return complete;

  const previewBytes = new TextEncoder().encode(result.output.preview);
  let lower = 0;
  let upper = previewBytes.byteLength;
  let best = render("");
  if (serializedBytes(best) > TOOL_OUTPUT_PREVIEW_MAX_BYTES) {
    throw new Error("Strict tool result metadata exceeds the model projection budget");
  }

  while (lower <= upper) {
    const candidateBytes = Math.floor((lower + upper) / 2);
    const projected = projectCanonicalText(previewBytes, "head-tail", {
      maxBytes: candidateBytes,
      maxLines: TOOL_OUTPUT_PREVIEW_MAX_LINES,
    }).preview;
    const candidate = render(projected);
    if (serializedBytes(candidate) <= TOOL_OUTPUT_PREVIEW_MAX_BYTES) {
      best = candidate;
      lower = candidateBytes + 1;
    } else {
      upper = candidateBytes - 1;
    }
  }

  return best;
}

function pushRecoveryMarker(modelMessages: ModelMessage[]): void {
  const latest = modelMessages.at(-1);
  if (latest?.role === "system" && latest.content === INTERRUPTION_RECOVERY_MARKER) return;
  modelMessages.push({ role: "system", content: INTERRUPTION_RECOVERY_MARKER });
}
