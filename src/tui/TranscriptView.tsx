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

// ─── Todo ───

interface TodoItemInput {
  id?: string;
  content: string;
  status: string;
}

function extractTodoItems(input: unknown): TodoItemInput[] {
  if (input == null || typeof input !== "object") return [];
  const todos = (input as Record<string, unknown>).todos;
  if (!Array.isArray(todos)) return [];
  return todos.filter(
    (item): item is TodoItemInput =>
      item != null && typeof item === "object" && typeof item.content === "string",
  );
}

function formatTodoStatusIcon(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "◉";
    case "cancelled":
      return "✕";
    default:
      return "○";
  }
}

function formatTodoItem(todo: TodoItemInput): string {
  return `  ${formatTodoStatusIcon(todo.status)} ${todo.content}`;
}

function getTodoColor(status: string): "green" | "yellow" | "gray" | undefined {
  switch (status) {
    case "completed":
      return "green";
    case "in_progress":
      return "yellow";
    case "cancelled":
      return "gray";
    default:
      return undefined;
  }
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

function renderTodoWritePart(part: ToolPart): RenderBlock[] {
  switch (part.state) {
    case "pending":
      return [{ id: part.id, content: "⚙ Updating todos...", color: "yellow" }];
    case "running":
      return [{ id: part.id, content: "⚙ Updating todos...", color: "yellow" }];
    case "completed": {
      const todos = extractTodoItems(part.input);
      const blocks: RenderBlock[] = [
        { id: part.id, content: "# Todos", color: "yellow", bold: true },
      ];
      for (let i = 0; i < todos.length; i++) {
        const todo = todos[i];
        blocks.push({
          id: `${part.id}:todo:${todo.id ?? i}`,
          content: formatTodoItem(todo),
          color: getTodoColor(todo.status),
        });
      }
      return blocks;
    }
    case "error":
      return [
        { id: part.id, content: formatToolCall(part.toolName), color: "yellow" },
        { id: `${part.id}:result`, content: formatToolResult(part.errorMessage, true), color: "red" },
      ];
  }
}

function renderToolPart(part: ToolPart): RenderBlock[] {
  if (part.toolName === "todo_write") {
    return renderTodoWritePart(part);
  }

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