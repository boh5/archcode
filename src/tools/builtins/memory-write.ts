import { z } from "zod";
import { MemoryFileManager, MemoryPathError } from "../../memory/file-manager";
import { INDEX_FILE, PREFERENCES_FILE } from "../../memory/constants";
import { containsSecretPattern } from "../../security/patterns";
import { sharedMutationQueue } from "../concurrency/mutation-queue";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionResult } from "../types";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const NAME_REGEX = /^[a-zA-Z0-9_]+$/;

const PREFERENCES_NAME = PREFERENCES_FILE.replace(".md", "");

const MemoryWriteInputSchema = z
  .object({
    name: z
      .string()
      .regex(NAME_REGEX, "Name must match /^[a-zA-Z0-9_]+$/"),
    description: z.string().optional(),
    type: z.enum(["user", "feedback", "project", "reference"]).optional(),
    content: z.string(),
    scope: z.enum(["project", "user"]).optional(),
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
      "Write or update memory. " +
      'Use name="preferences" to write user-level preferences (personal style, preferences). ' +
      "Use any other name to write a project knowledge topic (letters, numbers, underscores only). " +
      "Creates the file if it does not exist, or updates it if a file with the same name already exists. " +
      "Knowledge topics automatically rebuild the memory index after writing.",
    inputSchema: MemoryWriteInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    execute: async (input: MemoryWriteInput): Promise<string | ToolExecutionResult> => {
      // Resolve scope: preferences defaults to "user", topics default to "project"
      const resolvedScope = input.scope ?? (input.name === PREFERENCES_NAME ? "user" : "project");

      // Reject scope="user" for non-preferences names (user level only has preferences)
      if (resolvedScope === "user" && input.name !== PREFERENCES_NAME) {
        return createToolErrorResult({
          kind: "workspace",
          code: "TOOL_MEMORY_INVALID_SCOPE",
          message: 'Only "preferences" can be written at the user level. Knowledge topics are always project-level.',
        });
      }

      // Reject scope="project" for preferences (preferences are user-level only)
      if (resolvedScope === "project" && input.name === PREFERENCES_NAME) {
        return createToolErrorResult({
          kind: "workspace",
          code: "TOOL_MEMORY_INVALID_SCOPE",
          message: 'Preferences can only be written at the user level. Omit scope or use scope="user".',
        });
      }

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

      // --- Preferences path (name="preferences", scope="user") ---
      if (input.name === PREFERENCES_NAME) {
        return await sharedMutationQueue.enqueue(
          fileManager.userRoot,
          async () => {
            const existing = await fileManager.readPreferences();
            const merged = existing !== null
              ? `${existing.trimEnd()}\n\n---\n\n${input.content.trimEnd()}\n`
              : `${input.content.trimEnd()}\n`;
            await fileManager.writePreferences(merged);
            return `Wrote user preferences to preferences.md`;
          },
        );
      }

      // --- Knowledge topic path (project-level only) ---
      const frontmatter = {
        name: input.name,
        description: input.description ?? "",
        type: input.type ?? "project",
      };

      try {
        return await sharedMutationQueue.enqueue(
          fileManager.projectRoot,
          async () => {
            await fileManager.writeTopic(input.name, frontmatter, input.content);
            await fileManager.rebuildIndex();
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
