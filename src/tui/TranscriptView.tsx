import { Box, Text } from "ink";
import type { TranscriptEvent, TextDeltaEvent } from "../store/types";

export interface TranscriptViewProps {
  events: TranscriptEvent[];
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

export function formatTextDeltas(events: TextDeltaEvent[]): string {
  const stepTexts: string[] = [];
  let currentStep: number | undefined;
  let currentText = "";

  for (const event of events) {
    if (currentStep === undefined) {
      currentStep = event.step;
    }

    if (event.step !== currentStep) {
      stepTexts.push(currentText);
      currentStep = event.step;
      currentText = "";
    }

    currentText += event.text;
  }

  if (currentStep !== undefined) {
    stepTexts.push(currentText);
  }

  return stepTexts.join("\n\n");
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

function createTextDeltaBlock(buffer: TextDeltaEvent[]): RenderBlock | undefined {
  if (buffer.length === 0) return undefined;
  return {
    id: buffer.map((event) => event.id).join(":"),
    content: formatTextDeltas(buffer),
  };
}

function buildRenderBlocks(events: TranscriptEvent[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let textBuffer: TextDeltaEvent[] = [];

  const flushTextBuffer = () => {
    const block = createTextDeltaBlock(textBuffer);
    if (block) blocks.push(block);
    textBuffer = [];
  };

  for (const event of events) {
    if (event.type === "text-delta") {
      const previousEvent = textBuffer.at(-1);
      if (previousEvent && previousEvent.step !== event.step) {
        flushTextBuffer();
      }
      textBuffer.push(event);
      continue;
    }

    flushTextBuffer();

    switch (event.type) {
      case "user-message":
        blocks.push({
          id: event.id,
          content: formatUserMessage(event.content),
          color: "gray",
        });
        break;
      case "tool-call":
        blocks.push({
          id: event.id,
          content: formatToolCall(event.toolName),
          color: "yellow",
        });
        break;
      case "tool-result":
        blocks.push({
          id: event.id,
          content: formatToolResult(event.output, event.isError),
          color: event.isError ? "red" : "green",
        });
        break;
      case "loop-error":
        blocks.push({
          id: event.id,
          content: formatLoopError(event.error),
          color: "red",
          bold: true,
        });
        break;
    }
  }

  flushTextBuffer();
  return blocks;
}

export function TranscriptView({ events }: TranscriptViewProps) {
  return (
    <Box flexDirection="column">
      {buildRenderBlocks(events).map((block) => (
        <Text key={block.id} color={block.color} bold={block.bold}>
          {block.content}
        </Text>
      ))}
    </Box>
  );
}
