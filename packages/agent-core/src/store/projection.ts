import type { ModelMessage } from "ai";
import type { StoredMessage, StoredPart } from "./types";
import { redactValue } from "../tools/security";

export type ProjectionMode = "model" | "full-history";

export interface ProjectionOptions {
  mode?: ProjectionMode;
}

const INTERRUPTION_RECOVERY_MARKER =
  "<interrupted-response-recovery>\nThe previous assistant response was interrupted. Its partial assistant text was preserved in session history for visibility only and was intentionally omitted from this model context. Do not treat the omitted partial text as completed assistant output; continue from the user's latest request and, if needed, recover by restating only verified context.\n</interrupted-response-recovery>";

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
        if (part.type === "text" && part.completedAt !== undefined && !isDiscardedFromContext(part)) {
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

    const assistantContent: Extract<ModelMessage, { role: "assistant" }>["content"] = [];
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
      modelMessages.push({ role: "assistant", content: assistantContent });
    }

    if (toolContent.length > 0) {
      modelMessages.push({ role: "tool", content: toolContent });
    }
  }

  return modelMessages;
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
