import { Box, Text } from "ink";
import type {
  StoredMessage,
  StoredPart,
  TextPart,
  ReasoningPart,
  ToolPart,
  StreamingTextState,
  StreamingReasoningState,
  StreamingToolState,
} from "../store/types";

export interface TranscriptViewProps {
  messages: StoredMessage[];
  streamingText?: StreamingTextState;
  streamingReasoning?: StreamingReasoningState;
  streamingTools: Record<string, StreamingToolState>;
}

interface RenderBlock {
  id: string;
  content: string;
  color?: "gray" | "yellow" | "red" | "green";
  bold?: boolean;
}

export function formatUserMessage(content: string): string {
  return `> ${content}`;
}

export function formatTextPart(text: string): string {
  return text;
}

export function formatStreamingText(streamingText: StreamingTextState): string {
  return streamingText.text;
}

export function formatReasoningPart(text: string): string {
  return `💭 ${text}`;
}

export function formatToolCall(toolName: string): string {
  return `⚙ ${toolName}`;
}

export function formatToolResult(output: string, isError: boolean): string {
  const truncatedOutput = output.length > 200 ? `${output.slice(0, 200)}...` : output;
  return `${isError ? "✗" : "✓"} ${truncatedOutput}`;
}

export function formatLoopError(error: string): string {
  return `✗ ${error}`;
}

function getUserTextContent(parts: StoredPart[]): string {
  const textPart = parts.find((p) => p.type === "text") as TextPart | undefined;
  return textPart?.text ?? "";
}

function isStreamingTextMatch(
  part: TextPart,
  streamingText: StreamingTextState | undefined,
): boolean {
  return streamingText !== undefined && part.id === streamingText.partId;
}

function isStreamingReasoningMatch(
  part: ReasoningPart,
  streamingReasoning: StreamingReasoningState | undefined,
): boolean {
  return streamingReasoning !== undefined && part.id === streamingReasoning.partId;
}

export function buildRenderBlocks(
  messages: StoredMessage[],
  streamingText?: StreamingTextState,
  streamingReasoning?: StreamingReasoningState,
  streamingTools: Record<string, StreamingToolState> = {},
): RenderBlock[] {
  const blocks: RenderBlock[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      blocks.push({
        id: message.id,
        content: formatUserMessage(getUserTextContent(message.parts)),
        color: "gray",
      });
      continue;
    }

    for (const part of message.parts) {
      if (part.type === "text") {
        if (part.completedAt !== undefined) {
          blocks.push({
            id: part.id,
            content: formatTextPart(part.text),
          });
        } else if (isStreamingTextMatch(part, streamingText)) {
          blocks.push({
            id: `${part.id}:streaming`,
            content: formatStreamingText(streamingText!),
          });
        }
        continue;
      }

      if (part.type === "reasoning") {
        if (part.completedAt !== undefined) {
          blocks.push({
            id: part.id,
            content: formatReasoningPart(part.text),
          });
        } else if (isStreamingReasoningMatch(part, streamingReasoning)) {
          blocks.push({
            id: `${part.id}:streaming`,
            content: formatReasoningPart(streamingReasoning!.text),
          });
        }
        continue;
      }

      if (part.type === "tool") {
        const toolBlocks = renderToolPart(part);
        blocks.push(...toolBlocks);
        continue;
      }
    }
  }

  if (streamingText && !blocks.some((b) => b.id === `${streamingText.partId}:streaming`)) {
    blocks.push({
      id: `streaming-text:orphan`,
      content: formatStreamingText(streamingText),
    });
  }

  if (streamingReasoning && !blocks.some((b) => b.id === `${streamingReasoning.partId}:streaming`)) {
    blocks.push({
      id: `streaming-reasoning:orphan`,
      content: formatReasoningPart(streamingReasoning.text),
    });
  }

  for (const [toolCallId, streamingTool] of Object.entries(streamingTools)) {
    const alreadyRendered = messagePartsContainTool(messages, toolCallId);
    if (!alreadyRendered) {
      blocks.push({
        id: `streaming-tool:${toolCallId}`,
        content: formatToolCall(streamingTool.toolName),
        color: "yellow",
      });
    }
  }

  return blocks;
}

function messagePartsContainTool(messages: StoredMessage[], toolCallId: string): boolean {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool" && part.toolCallId === toolCallId) {
        return true;
      }
    }
  }
  return false;
}

function renderToolPart(part: ToolPart): RenderBlock[] {
  const blocks: RenderBlock[] = [];

  switch (part.state) {
    case "pending": {
      blocks.push({
        id: part.id,
        content: formatToolCall(part.toolName),
        color: "yellow",
      });
      break;
    }
    case "running": {
      blocks.push({
        id: part.id,
        content: `${formatToolCall(part.toolName)} (running)`,
        color: "yellow",
      });
      break;
    }
    case "completed": {
      blocks.push({
        id: part.id,
        content: formatToolCall(part.toolName),
        color: "yellow",
      });
      blocks.push({
        id: `${part.id}:result`,
        content: formatToolResult(part.output, false),
        color: "green",
      });
      break;
    }
    case "error": {
      blocks.push({
        id: part.id,
        content: formatToolCall(part.toolName),
        color: "yellow",
      });
      blocks.push({
        id: `${part.id}:result`,
        content: formatToolResult(part.errorMessage, true),
        color: "red",
      });
      break;
    }
  }

  return blocks;
}

export function TranscriptView({
  messages,
  streamingText,
  streamingReasoning,
  streamingTools,
}: TranscriptViewProps) {
  return (
    <Box flexDirection="column">
      {buildRenderBlocks(messages, streamingText, streamingReasoning, streamingTools).map(
        (block) => (
          <Text key={block.id} color={block.color} bold={block.bold}>
            {block.content}
          </Text>
        ),
      )}
    </Box>
  );
}