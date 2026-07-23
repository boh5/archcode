import {
  TOOL_ASK_USER,
  TOOL_DELEGATE,
  type ReasoningPart,
  type SessionMessage,
  type SessionPart,
  type ToolPart,
} from "@archcode/protocol";
import type { ExecutionWorkstreamMessageSlice } from "./execution-workstream";

export interface ToolRunItem {
  readonly message: SessionMessage;
  readonly part: ReasoningPart | ToolPart;
}

export interface ToolRunTimelineMessage {
  readonly kind: "message";
  readonly id: string;
  readonly message: SessionMessage;
  readonly parts: readonly SessionPart[];
  readonly showMeta: boolean;
}

export interface ToolRunTimelineRun {
  readonly kind: "tool-run";
  readonly id: string;
  readonly items: readonly ToolRunItem[];
  readonly tools: readonly ToolPart[];
}

export type ToolRunTimelineEntry = ToolRunTimelineMessage | ToolRunTimelineRun;

interface MutableMessageEntry {
  kind: "message";
  id: string;
  message: SessionMessage;
  parts: SessionPart[];
  showMeta: boolean;
}

type MutableTimelineEntry = MutableMessageEntry | ToolRunTimelineRun;

function isOrdinaryTool(part: SessionPart): part is ToolPart {
  return part.type === "tool"
    && part.toolName !== TOOL_DELEGATE
    && part.toolName !== TOOL_ASK_USER;
}

/**
 * Projects ordered Work parts into flat message fragments and Tool Runs.
 *
 * Reasoning is transparent while tools are being called. Rendered text and
 * control parts are hard boundaries. A run is promoted only after its second
 * ordinary tool, so singleton tools keep the existing direct ToolCard surface.
 */
export function buildToolRunTimeline(
  slices: readonly ExecutionWorkstreamMessageSlice[],
): readonly ToolRunTimelineEntry[] {
  const timeline: MutableTimelineEntry[] = [];
  let candidates: ToolRunItem[] = [];

  const appendMessagePart = (message: SessionMessage, part: SessionPart): void => {
    const previous = timeline.at(-1);
    if (previous?.kind === "message" && previous.message === message) {
      previous.parts.push(part);
      return;
    }
    timeline.push({
      kind: "message",
      id: `message-fragment:${message.id}:${part.id}`,
      message,
      parts: [part],
      showMeta: false,
    });
  };

  const flushCandidates = (): void => {
    if (candidates.length === 0) return;
    const tools = candidates.flatMap((item) => item.part.type === "tool" ? [item.part] : []);
    if (tools.length >= 2) {
      timeline.push({
        kind: "tool-run",
        id: `tool-run:${tools[0].id}`,
        items: candidates,
        tools,
      });
    } else {
      for (const candidate of candidates) {
        appendMessagePart(candidate.message, candidate.part);
      }
    }
    candidates = [];
  };

  for (const slice of slices) {
    if (slice.message.role !== "assistant") {
      flushCandidates();
      for (const part of slice.parts) appendMessagePart(slice.message, part);
      continue;
    }

    for (const part of slice.parts) {
      if (part.type === "reasoning" || isOrdinaryTool(part)) {
        candidates.push({ message: slice.message, part });
        continue;
      }
      flushCandidates();
      appendMessagePart(slice.message, part);
    }
  }
  flushCandidates();

  const lastTimelineEntryByMessageId = new Map<string, number>();
  timeline.forEach((entry, index) => {
    if (entry.kind === "message") {
      lastTimelineEntryByMessageId.set(entry.message.id, index);
      return;
    }
    for (const item of entry.items) {
      lastTimelineEntryByMessageId.set(item.message.id, index);
    }
  });

  return timeline.map((entry, index) => entry.kind === "message"
    ? { ...entry, showMeta: lastTimelineEntryByMessageId.get(entry.message.id) === index }
    : entry);
}
