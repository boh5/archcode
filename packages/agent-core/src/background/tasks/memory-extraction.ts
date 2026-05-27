import type { StoreApi } from "zustand/vanilla";
import type { BackgroundTask, BackgroundTaskContext } from "../types";
import type { CompletedToolPart, SessionStoreState, StoredMessage, TextPart } from "../../store/types";
import type { MemoryRoots } from "../../memory/types";
import type { MemoryExtractionResult } from "../../memory/schemas";
import { MemoryExtractionResultSchema } from "../../memory/schemas";
import { MemoryFileManager } from "../../memory/file-manager";
import { toModelMessagesFromStoredMessages } from "../../store/projection";
import { llmObject, LlmSchemaValidationError, LlmObjectError } from "../../llm";
import {
  MIN_MESSAGES_FOR_EXTRACTION,
  MIN_CONTENT_LENGTH_FOR_EXTRACTION,
  DEFAULT_EXTRACTION_MAX_MESSAGES,
} from "../../memory/constants";
import { containsSecretPattern } from "../../security/patterns";
import { buildMemoryManifest } from "../../memory/manifest";

const READ_TOOLS = new Set([
  "file_read",
  "grep",
  "glob",
  "git_status",
  "git_diff",
  "lsp_diagnostics",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_symbols",
  "web_fetch",
  "background_output",
  "view_tool_output",
  "memory_read",
  "workflow_read",
  "artifact_read",
]);

export function filterMessagesForExtraction(messages: StoredMessage[]): StoredMessage[] {
  const filtered: StoredMessage[] = [];

  for (const message of messages) {
    const parts: StoredMessage["parts"] = [];

    for (const part of message.parts) {
      if (part.type === "text") {
        if (message.role !== "user") continue;
        parts.push({
          ...part,
          text: part.text.slice(0, 4000),
        } as TextPart);
        continue;
      }

      if (part.type !== "tool") continue;
      if (part.state !== "completed") continue;
      if (!READ_TOOLS.has(part.toolName)) continue;

      const toolPart = part as CompletedToolPart;
      parts.push({
        ...toolPart,
        output: toolPart.output.slice(0, 1000),
      });
    }

    if (parts.length > 0) {
      filtered.push({ ...message, parts } as StoredMessage);
    }
  }

  return filtered;
}

/**
 * Create a background task that extracts durable memories from the
 * conversation history and writes them as topic files via MemoryFileManager.
 *
 * Short sessions (< MIN_MESSAGES_FOR_EXTRACTION messages or
 * < MIN_CONTENT_LENGTH_FOR_EXTRACTION chars) are skipped entirely.
 * LLM failures are caught and logged — no partial writes occur.
 */
export interface MemoryExtractionTaskConfig {
  minMessages?: number;
  minContentLength?: number;
}

export function createMemoryExtractionTask(
  store: StoreApi<SessionStoreState>,
  memoryRoots: MemoryRoots,
  fromIndex = 0,
  config?: MemoryExtractionTaskConfig,
): BackgroundTask {
  const effectiveMinMessages = config?.minMessages ?? MIN_MESSAGES_FOR_EXTRACTION;
  const effectiveMinContentLength = config?.minContentLength ?? MIN_CONTENT_LENGTH_FOR_EXTRACTION;

  return {
    name: "memory-extraction",

    run: async (ctx: BackgroundTaskContext) => {
      const state = store.getState();
      const messages = state.messages.slice(fromIndex);

      const filteredMessages = filterMessagesForExtraction(messages);
      const userMessages = messages.filter((m) => m.role === "user");
      if (userMessages.length < effectiveMinMessages) return;

      const totalContentLength = filteredMessages.reduce((sum, m) => {
        return (
          sum +
          m.parts
            .filter((p): p is TextPart => p.type === "text")
            .reduce((s, p) => s + p.text.length, 0)
        );
      }, 0);
      if (totalContentLength < effectiveMinContentLength) return;

      // --- Build memory manifest (existing memories) -------------------------
      const fileManager = new MemoryFileManager(memoryRoots);
      let manifestSection = "";
      try {
        const manifest = await buildMemoryManifest(fileManager);
        if (manifest.length > 0) {
          manifestSection = `\nExisting memories (check these before creating new topics):\n\n${manifest}\n`;
        }
      } catch (err) {
        ctx.logger.warn("memory.extraction.manifest.failed", {
          error: err,
          context: { sessionId: state.sessionId },
        });
      }

      // --- Build truncated conversation for LLM --------------------------------
      const maxMessages = DEFAULT_EXTRACTION_MAX_MESSAGES;
      const modelMessages = toModelMessagesFromStoredMessages(filteredMessages, { mode: "full-history" });
      const truncated = modelMessages.slice(-maxMessages);

      const MAX_CONTENT_CHARS = 4000;
      const conversationText = truncated
        .map((msg) => {
          const role = msg.role;
          let content: string;
          if (typeof msg.content === "string") {
            content = msg.content;
          } else if (Array.isArray(msg.content)) {
            content = msg.content
              .map((part) => {
                if (typeof part === "string") return part;
                if (part && typeof part === "object" && "text" in part) return part.text;
                if (part && typeof part === "object" && "output" in part) {
                  const output = part.output;
                  if (output && typeof output === "object" && "value" in output) {
                    return String(output.value);
                  }
                }
                return "";
              })
              .join(" ");
          } else {
            content = String(msg.content ?? "");
          }
          if (content.length > MAX_CONTENT_CHARS) {
            content = content.slice(0, MAX_CONTENT_CHARS) + "\n[...truncated]";
          }
          return `${role}: ${content}`;
        })
        .join("\n\n");

      // --- Call LLM ------------------------------------------------------------
      let result: MemoryExtractionResult;
      try {
        result = await llmObject({
          model: ctx.modelInfo.model,
          modelOptions: ctx.modelOptions,
          schema: MemoryExtractionResultSchema,
          prompt: `Extract durable knowledge, preferences, and feedback from this conversation.
Focus on information that would be useful in future sessions:
- User preferences and working style → classify as type "user" (these go to user-level preferences)
- Project conventions and architecture decisions → classify as type "project" (these go to project knowledge)
- Recurring feedback or corrections → classify as type "feedback" (these go to project knowledge)
- Important technical references → classify as type "reference" (these go to project knowledge)

Exclude: secrets, temporary details, error messages, and anything session-specific.
Memories with type "user" will be saved to the user's personal preferences (not project knowledge).
${manifestSection}Deduplication rules:
- The "name" field must exactly match the "name" value from the existing knowledge topics list above if the topic already exists.
- If a knowledge topic matches an existing entry, set shouldCreate to false and reuse the exact same "name" — the new content will be appended to that topic.
- If no matching topic exists, set shouldCreate to true with a new unique "name".
- For type "user" memories, always set shouldCreate to true (these go to preferences, which always appends).

Conversation:
${conversationText}`,
        });
      } catch (err) {
        if (err instanceof LlmSchemaValidationError) {
          ctx.logger.warn("memory.extraction.llm.validation.failed", {
            error: err,
            context: { sessionId: state.sessionId },
          });
          return;
        }
        if (err instanceof LlmObjectError) {
          ctx.logger.warn("memory.extraction.llm.failed", {
            error: err,
            context: { sessionId: state.sessionId },
          });
          return;
        }
        ctx.logger.warn("memory.extraction.llm.failed", {
          error: err,
          context: { sessionId: state.sessionId },
        });
        return;
      }

      store.setState({ lastExtractionIndex: state.messages.length });

      if (result.memories.length === 0) return;

      // --- Write memories ----------
      const TOPIC_NAME_REGEX = /^[a-zA-Z0-9_]+$/;

      for (const memory of result.memories) {
        try {
          const secretCheck = containsSecretPattern(memory.content);
          if (secretCheck.found) {
            ctx.logger.warn("memory.extraction.secret.skipped", {
              context: { sessionId: state.sessionId },
              meta: { memoryName: memory.name, patterns: secretCheck.patterns },
            });
            continue;
          }

          if (memory.type === "user") {
            const existing = await fileManager.readPreferences();
            const merged = existing !== null
              ? `${existing.trimEnd()}\n\n---\n\n${memory.content.trimEnd()}\n`
              : `${memory.content.trimEnd()}\n`;
            await fileManager.writePreferences(merged);
          } else {
            if (!TOPIC_NAME_REGEX.test(memory.name)) {
              ctx.logger.warn("memory.extraction.topic.invalid", {
                context: { sessionId: state.sessionId },
                meta: { memoryName: memory.name },
              });
              continue;
            }

            // Write safety net: always check if topic exists.
            // If it exists, merge regardless of shouldCreate to prevent overwriting.
            const existingTopic = await fileManager.readTopic(memory.name);
            if (existingTopic) {
              const mergedContent = `${existingTopic.content}\n\n---\n\n${memory.content}`;
              await fileManager.writeTopic(
                memory.name,
                {
                  name: memory.title,
                  description: memory.description,
                  type: memory.type,
                },
                mergedContent,
              );
            } else {
              await fileManager.writeTopic(
                memory.name,
                {
                  name: memory.title,
                  description: memory.description,
                  type: memory.type,
                },
                memory.content,
              );
            }
          }
        } catch (err) {
          ctx.logger.warn("memory.extraction.write.failed", {
            error: err,
            context: { sessionId: state.sessionId },
            meta: { memoryName: memory.name, memoryType: memory.type },
          });
        }
      }

      // --- Rebuild index -----------------------------------------------------
      try {
        await fileManager.rebuildIndex();
      } catch (err) {
        ctx.logger.warn("memory.extraction.index.failed", {
          error: err,
          context: { sessionId: state.sessionId },
        });
      }
    },
  };
}
