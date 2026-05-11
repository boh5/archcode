import { z } from "zod";
import { MemoryFileManager, MemoryPathError } from "../../memory/file-manager";
import { INDEX_FILE } from "../../memory/constants";
import { containsSecretPattern } from "../../security/patterns";
import { sharedMutationQueue } from "../concurrency/mutation-queue";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionResult } from "../types";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const NAME_REGEX = /^[a-zA-Z0-9_]+$/;

const MemoryWriteInputSchema = z
  .object({
    name: z
      .string()
      .regex(NAME_REGEX, "Name must match /^[a-zA-Z0-9_]+$/"),
    description: z.string(),
    type: z.enum(["user", "feedback", "project", "reference"]),
    content: z.string(),
    scope: z.enum(["project", "user"]).default("project"),
  })
  .strict();

type MemoryWriteInput = z.infer<typeof MemoryWriteInputSchema>;

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createMemoryWriteTool(fileManager: MemoryFileManager) {
  return defineTool({
    name: "memory_write",
    description:
      "Write or update a memory topic file. The name parameter identifies the topic (letters, numbers, underscores only). " +
      "Creates the file if it does not exist, or updates it if a file with the same name already exists. " +
      "Automatically rebuilds the memory index after writing.",
    inputSchema: MemoryWriteInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    execute: async (input: MemoryWriteInput): Promise<string | ToolExecutionResult> => {
      if (input.name === INDEX_FILE.replace(".md", "")) {
        return createToolErrorResult({
          kind: "workspace",
          code: "TOOL_MEMORY_INVALID_NAME",
          message: `Writing to "${INDEX_FILE}" is not allowed`,
        });
      }

      const secretCheck = containsSecretPattern(input.content);
      if (secretCheck.found) {
        return createToolErrorResult({
          kind: "execution",
          code: "TOOL_MEMORY_SECRET_DETECTED",
          message: `Content contains potential secrets (matched patterns: ${secretCheck.patterns.join(", ")}). Remove secrets before writing to memory.`,
        });
      }

      const frontmatter = {
        name: input.name,
        description: input.description,
        type: input.type,
      };

      const scopeRoot =
        input.scope === "user" ? fileManager.userRoot : fileManager.projectRoot;

      try {
        return await sharedMutationQueue.enqueue(
          scopeRoot,
          async () => {
            await fileManager.writeTopic(input.name, frontmatter, input.content, input.scope);
            if (input.scope === "project") {
              await fileManager.rebuildIndex();
            }
            return `Wrote memory topic "${input.name}" to knowledge/${input.name}.md`;
          },
        );
      } catch (error) {
        if (error instanceof MemoryPathError) {
          return createToolErrorResult({
            kind: "workspace",
            code: "TOOL_MEMORY_INVALID_NAME",
            message: error.message,
          });
        }
        return createToolErrorResult({
          kind: "execution",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },
  });
}

export const memoryWriteTool = createMemoryWriteTool;
export { MemoryWriteInputSchema };
