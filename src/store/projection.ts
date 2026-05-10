import type { ModelMessage } from "ai";
import type { Reminder, StoredMessage } from "./types";
import { redactValue } from "../tools/hooks/redact";

export function toModelMessagesFromStoredMessages(
  messages: StoredMessage[],
  reminders?: Reminder[],
): ModelMessage[] {
  const modelMessages: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      let content = "";

      for (const part of message.parts) {
        if (part.type === "text" && part.completedAt !== undefined) {
          content += part.text;
        }
      }

      if (content.length > 0) {
        modelMessages.push({ role: "user", content });
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

  if (reminders === undefined || reminders.length === 0) {
    return modelMessages;
  }

  const injectedReminders = reminders
    .filter((reminder) => reminder.delivery === "auto_inject" && reminder.consumedAt === null)
    .sort((left, right) => left.createdAt - right.createdAt);

  for (const reminder of injectedReminders) {
    modelMessages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `<system-reminder>\n${reminder.content}\n</system-reminder>`,
        },
      ],
    });
  }

  return modelMessages;
}
