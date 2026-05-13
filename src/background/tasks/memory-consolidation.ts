import type { BackgroundTask, BackgroundTaskContext } from "../types";
import { MemoryConsolidationResultSchema } from "../../memory/schemas";
import { MemoryFileManager, parseIndex } from "../../memory/file-manager";
import { DEFAULT_MAX_INDEX_LINES } from "../../memory/constants";
import { llmObject, LlmSchemaValidationError } from "../../llm";

export function createMemoryConsolidationTask(
  memoryRoots: { project: string; user: string },
): BackgroundTask {
  return {
    name: "memory-consolidation",

    async run(ctx: BackgroundTaskContext): Promise<void> {
      const fileManager = new MemoryFileManager(memoryRoots);

      const indexContent = await fileManager.readIndex();
      if (indexContent === null) return;

      const entries = parseIndex(indexContent);
      if (entries.length === 0) return;

      const topicDescriptions: Record<string, string> = {};
      for (const entry of entries) {
        const topic = await fileManager.readTopic(entry.name);
        if (topic) {
          topicDescriptions[entry.name] = topic.description;
        }
      }

      const entriesText = entries
        .map((e) => `- [${e.title}](${e.name}) — ${e.summary}`)
        .join("\n");

      const descriptionsText = Object.entries(topicDescriptions)
        .map(([name, desc]) => `${name}: ${desc}`)
        .join("\n");

      try {
        const result = await llmObject({
          model: ctx.modelInfo.model,
          schema: MemoryConsolidationResultSchema,
          prompt: `You are a memory consolidation system. Reorganize the following memory index to be more concise and remove duplicates.

Current index entries:
${entriesText}

Topic descriptions:
${descriptionsText}

Instructions:
- Merge similar topics (reduce duplicate entries)
- Remove stale or erroneous entries
- Rewrite summaries to be concise
- Keep under ${DEFAULT_MAX_INDEX_LINES} entries
- Do NOT delete or rename topic files — only reorganize index entries
- Preserve the name values exactly as they are (they reference actual files)
- Each entry must reference an existing topic file`,
        });

        const existingNames = new Set(await fileManager.listTopics());

        const validEntries = result.entries.filter((entry) =>
          existingNames.has(entry.name),
        );

        await fileManager.writeIndex(validEntries);
      } catch (err) {
        if (err instanceof LlmSchemaValidationError) {
          console.warn(
            "Memory consolidation: LLM output validation failed:",
            err.message,
          );
          return;
        }
        console.warn(
          "Memory consolidation failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  };
}