import type { ModelMessage } from "ai";
import type { StoredMessage } from "./types";
import { redactValue } from "../tools/security";

export type ProjectionMode = "model" | "full-history";

export interface ProjectionOptions {
  mode?: ProjectionMode;
}

export function toModelMessagesFromStoredMessages(
  messages: StoredMessage[],
  options?: ProjectionOptions,
): ModelMessage[] {
  const mode = options?.mode ?? "model";
  const modelMessages: ModelMessage[] = [];

  for (const message of messages) {
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
        if (part.type === "text" && part.completedAt !== undefined) {
          content += part.text;
        }
      }

      if (content.length > 0) {
        modelMessages.push({ role: "user", content });
      }

      continue;
    }

    if (mode === "full-history") {
      const assistantContent: Extract<ModelMessage, { role: "assistant" }>["content"] = [];
      const toolContent: Extract<ModelMessage, { role: "tool" }>["content"] = [];

      for (const part of message.parts) {
        if (part.type === "system-notice" || part.type === "recovery-notice") continue;

        if (part.type === "text") {
          if (part.completedAt !== undefined) {
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

    const assistantContent: Extract<ModelMessage, { role: "assistant" }>["content"] = [];
    const toolContent: Extract<ModelMessage, { role: "tool" }>["content"] = [];

    for (const part of message.parts) {
      if (part.type === "text") {
        if (part.completedAt !== undefined) {
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
      modelMessages.push({ role: "assistant", content: assistantContent });
    }

    if (toolContent.length > 0) {
      modelMessages.push({ role: "tool", content: toolContent });
    }
  }

  return modelMessages;
}
