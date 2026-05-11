import { generateObject as aiGenerateObject } from "ai";
import type { StoreApi } from "zustand/vanilla";
import type { BackgroundTask, BackgroundTaskContext } from "../types";
import type { Registry } from "../../provider/index";
import type { SessionStoreState, TextPart } from "../../store/types";
import type { MemoryRoots } from "../../memory/types";
import { MemoryExtractionResultSchema } from "../../memory/schemas";
import { MemoryFileManager } from "../../memory/file-manager";

let _generateObject: typeof aiGenerateObject = aiGenerateObject;

export function __setGenerateObjectForTest(fn: typeof aiGenerateObject) {
  _generateObject = fn;
}
import {
  MIN_MESSAGES_FOR_EXTRACTION,
  MIN_CONTENT_LENGTH_FOR_EXTRACTION,
  DEFAULT_EXTRACTION_MAX_MESSAGES,
} from "../../memory/constants";

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
  providerRegistry: Registry,
  memoryRoots: MemoryRoots,
): BackgroundTask {
  return {
    name: "memory-extraction",

    run: async (_ctx: BackgroundTaskContext) => {
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
      const modelMessages = state.toModelMessages();
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
      let result;
      try {
        const modelId = providerRegistry.modelIds[0];
        const modelInfo = providerRegistry.getModel(modelId);

        const { object } = await _generateObject({
          model: modelInfo.model,
          schema: MemoryExtractionResultSchema,
          prompt: `Extract durable knowledge, preferences, and feedback from this conversation.
Focus on information that would be useful in future sessions:
- User preferences and working style
- Project conventions and architecture decisions
- Recurring feedback or corrections
- Important technical context

Exclude: secrets, temporary details, error messages, and anything session-specific.
Prefer updating existing topics over creating duplicates.

Conversation:
${conversationText}`,
        });

        result = object;
      } catch (err) {
        console.warn(
          "Memory extraction LLM call failed:",
          err instanceof Error ? err.message : String(err),
        );
        return;
      }

      // --- Validate result ---------------------------------------------------
      let memories: Array<{
        title: string;
        name: string;
        description: string;
        type: "user" | "feedback" | "project" | "reference";
        content: string;
        shouldCreate: boolean;
      }>;

      try {
        // Re-validate through schema to catch any LLM output issues
        const parsed = MemoryExtractionResultSchema.parse(result);
        memories = parsed.memories;
      } catch (err) {
        console.warn(
          "Memory extraction result validation failed:",
          err instanceof Error ? err.message : String(err),
        );
        return;
      }

      if (memories.length === 0) return;

      // --- Write topic files -------------------------------------------------
      const fileManager = new MemoryFileManager(memoryRoots);

      for (const memory of memories) {
        try {
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
            // Merge into existing topic
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
              // Topic doesn't exist yet — create it anyway
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
          console.warn(
            `Memory extraction: failed to write topic "${memory.name}":`,
            err instanceof Error ? err.message : String(err),
          );
          // Continue with other topics
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