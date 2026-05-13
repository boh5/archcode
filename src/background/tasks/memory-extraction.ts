import type { StoreApi } from "zustand/vanilla";
import type { BackgroundTask, BackgroundTaskContext } from "../types";
import type { SessionStoreState, TextPart } from "../../store/types";
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

/**
 * Create a background task that extracts durable memories from the
 * conversation history and writes them as topic files via MemoryFileManager.
 *
 * Short sessions (< MIN_MESSAGES_FOR_EXTRACTION messages or
 * < MIN_CONTENT_LENGTH_FOR_EXTRACTION chars) are skipped entirely.
 * LLM failures are caught and logged — no partial writes occur.
 */
export function createMemoryExtractionTask(
  store: StoreApi<SessionStoreState>,
  memoryRoots: MemoryRoots,
): BackgroundTask {
  return {
    name: "memory-extraction",

    run: async (ctx: BackgroundTaskContext) => {
      const state = store.getState();

      // --- Short-session skip ------------------------------------------------
      const userMessages = state.messages.filter((m) => m.role === "user");
      if (userMessages.length < MIN_MESSAGES_FOR_EXTRACTION) return;

      const totalContentLength = state.messages.reduce((sum, m) => {
        return (
          sum +
          m.parts
            .filter((p): p is TextPart => p.type === "text")
            .reduce((s, p) => s + p.text.length, 0)
        );
      }, 0);
      if (totalContentLength < MIN_CONTENT_LENGTH_FOR_EXTRACTION) return;

      // --- Build truncated conversation for LLM ------------------------------
      const maxMessages = DEFAULT_EXTRACTION_MAX_MESSAGES;
      const modelMessages = toModelMessagesFromStoredMessages(state.messages, { mode: "full-history" });
      const truncated = modelMessages.slice(-maxMessages);

      // Truncate individual message content to a reasonable token limit
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

      // --- Call LLM ----------------------------------------------------------
      let result: MemoryExtractionResult;
      try {
        result = await llmObject({
          model: ctx.modelInfo.model,
          schema: MemoryExtractionResultSchema,
          prompt: `Extract durable knowledge, preferences, and feedback from this conversation.
Focus on information that would be useful in future sessions:
- User preferences and working style → classify as type "user" (these go to user-level preferences)
- Project conventions and architecture decisions → classify as type "project" (these go to project knowledge)
- Recurring feedback or corrections → classify as type "feedback" (these go to project knowledge)
- Important technical references → classify as type "reference" (these go to project knowledge)

Exclude: secrets, temporary details, error messages, and anything session-specific.
Prefer updating existing topics over creating duplicates.
Memories with type "user" will be saved to the user's personal preferences (not project knowledge).

Conversation:
${conversationText}`,
        });
      } catch (err) {
        if (err instanceof LlmSchemaValidationError) {
          console.warn("Memory extraction: LLM output validation failed:", err.message);
          return;
        }
        if (err instanceof LlmObjectError) {
          console.warn("Memory extraction LLM call failed:", err.message);
          return;
        }
        console.warn(
          "Memory extraction LLM call failed:",
          err instanceof Error ? err.message : String(err),
        );
        return;
      }

      if (result.memories.length === 0) return;

      // --- Write memories ----------
      const fileManager = new MemoryFileManager(memoryRoots);

      const TOPIC_NAME_REGEX = /^[a-zA-Z0-9_]+$/;

      for (const memory of result.memories) {
        try {
          const secretCheck = containsSecretPattern(memory.content);
          if (secretCheck.found) {
            console.warn(
              `Memory extraction: skipping "${memory.name}" — content contains potential secrets (${secretCheck.patterns.join(", ")})`,
            );
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
              console.warn(
                `Memory extraction: skipping topic "${memory.name}" — name contains invalid characters (only letters, numbers, underscores allowed)`,
              );
              continue;
            }

            if (memory.shouldCreate) {
              await fileManager.writeTopic(
                memory.name,
                {
                  name: memory.title,
                  description: memory.description,
                  type: memory.type,
                },
                memory.content,
              );
            } else {
              const existing = await fileManager.readTopic(memory.name);
              if (existing) {
                const mergedContent = `${existing.content}\n\n---\n\n${memory.content}`;
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
          }
        } catch (err) {
          console.warn(
            `Memory extraction: failed to write "${memory.name}":`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // --- Rebuild index -----------------------------------------------------
      try {
        await fileManager.rebuildIndex();
      } catch (err) {
        console.warn(
          "Memory extraction: failed to rebuild index:",
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  };
}