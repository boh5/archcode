import {
  getToolCategory,
  TOOL_ASK_USER,
  TOOL_DELEGATE,
  type SessionMessage,
  type SessionPart,
  type ToolPart,
} from "@archcode/protocol";
import type { ExecutionWorkstreamMessageSlice } from "./execution-workstream";

export interface ToolRunItem {
  readonly message: SessionMessage;
  readonly part: ToolPart;
}

export interface ToolRunTimelineMessage {
  readonly kind: "message";
  readonly id: string;
  readonly message: SessionMessage;
  readonly parts: readonly SessionPart[];
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
}

type MutableTimelineEntry = MutableMessageEntry | ToolRunTimelineRun;

function isOrdinaryTool(part: SessionPart): part is ToolPart {
  if (
    part.type !== "tool"
    || part.toolName === TOOL_DELEGATE
    || part.toolName === TOOL_ASK_USER
  ) {
    return false;
  }
  const category = getToolCategory(part.toolName);
  return category !== "fileWrite" && category !== "shell";
}

/**
 * Projects ordered Work parts into flat message fragments and Tool Runs.
 *
 * Only contiguous ordinary tools can form a Tool Run. Reasoning, rendered text,
 * and control parts are hard boundaries and remain independent entries in the
 * outer Work timeline. A run is promoted only after its second ordinary tool,
 * so singleton tools keep the direct ToolCard presentation.
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
    });
  };

  const flushCandidates = (): void => {
    if (candidates.length === 0) return;
    if (candidates.length >= 2) {
      const tools = candidates.map((item) => item.part);
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
      if (isOrdinaryTool(part)) {
        candidates.push({ message: slice.message, part });
        continue;
      }
      flushCandidates();
      appendMessagePart(slice.message, part);
    }
  }
  flushCandidates();

  return timeline;
}
