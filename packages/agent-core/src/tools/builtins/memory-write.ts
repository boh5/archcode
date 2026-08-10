import { z } from "zod";
import {
  MemoryCapacityError,
  MemoryPathError,
  MemoryRevisionConflictError,
  MemorySecretError,
  MemoryValidationError,
} from "../../memory";
import { INDEX_FILE, PREFERENCES_FILE } from "../../memory/constants";
import { containsSecretPattern } from "../../security/patterns";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type { ToolExecutionContext } from "../types";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const NAME_REGEX = /^[a-zA-Z0-9_]+$/;

const PREFERENCES_NAME = PREFERENCES_FILE.replace(".md", "");

const MemoryWriteInputSchema = z
  .object({
    name: z
      .string()
      .regex(NAME_REGEX, "Name must match /^[a-zA-Z0-9_]+$/")
      .describe("Memory entry name. \"preferences\" writes user-level preferences. Otherwise a project knowledge topic name (letters/numbers/underscores only)."),
    description: z.string().optional().describe("Short human-readable description of the memory entry"),
    type: z.enum(["user", "feedback", "project", "reference"]).optional().describe("Memory type: \"user\" (personal style), \"feedback\" (correction), \"project\" (project-specific knowledge), \"reference\" (external reference). Defaults to \"project\" for knowledge topics."),
    content: z.string().describe("Full markdown content of the memory entry"),
    scope: z.enum(["project", "user"]).optional().describe("Storage scope: \"project\" (workspace-specific) or \"user\" (cross-workspace). Inferred from name if omitted: \"preferences\" → \"user\", topics → \"project\"."),
  })
  .strict();

type MemoryWriteInput = z.infer<typeof MemoryWriteInputSchema>;

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createMemoryWriteTool() {
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
    outputPolicy: { kind: "inline", previewDirection: "head" },
    execute: async (input: MemoryWriteInput, ctx: ToolExecutionContext) => {
      const memory = ctx.projectContext.memory;
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
        try {
          await memory.writeExplicit({
            name: input.name,
            content: input.content,
            scope: resolvedScope,
          });
          return createTextToolResult("Wrote user preferences to preferences.md");
        } catch (error) {
          return memoryWriteFailure(error);
        }
      }

      // --- Knowledge topic path (project-level only) ---
      try {
        await memory.writeExplicit({
          name: input.name,
          description: input.description ?? "",
          type: input.type ?? "project",
          content: input.content,
          scope: resolvedScope,
        });
        return createTextToolResult(`Wrote memory topic "${input.name}" to knowledge/${input.name}.md`);
      } catch (error) {
        return memoryWriteFailure(error);
      }
    },
  });
}

function memoryWriteFailure(error: unknown) {
  if (error instanceof MemoryPathError) {
    return createToolErrorResult({
      kind: "workspace",
      code: "TOOL_FILE_OUTSIDE_WORKSPACE",
      message: "Memory path is outside the configured Memory roots",
    });
  }
  if (error instanceof MemoryValidationError) {
    return createToolErrorResult({
      kind: "workspace",
      code: "TOOL_MEMORY_INVALID_NAME",
      message: error.message,
    });
  }
  if (error instanceof MemoryCapacityError) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_MEMORY_CAPACITY_EXCEEDED",
      message: error.message,
    });
  }
  if (error instanceof MemorySecretError) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_MEMORY_SECRET_DETECTED",
      message: "Memory content contains a potential secret. Remove secrets before writing to Memory.",
    });
  }
  if (error instanceof MemoryRevisionConflictError) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_MEMORY_REVISION_CONFLICT",
      message: "Memory changed before the write could be applied. Read the latest Memory and retry.",
    });
  }
  return createToolErrorResult({
    kind: "execution",
    code: "TOOL_MEMORY_WRITE_FAILED",
    message: "Memory could not be written",
  });
}

export const memoryWriteTool = createMemoryWriteTool;
export { MemoryWriteInputSchema };
