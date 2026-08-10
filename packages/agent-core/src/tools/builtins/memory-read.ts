import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type { RawToolResult, ToolExecutionContext } from "../types";
import {
  MEMORY_CONTEXT_END,
  MEMORY_CONTEXT_START,
  MemoryService,
  MemoryPathError,
  PREFERENCES_MARKER_END,
  PREFERENCES_MARKER_START,
} from "../../memory";
import { BoundedFileReadError, ONE_SHOT_FILE_READ_MAX_BYTES } from "../../utils/safe-file";

// ─── Input Schema ───

const MemoryReadInputSchema = z
  .object({
    name: z.string().optional().describe("Omit for complete in-capacity preferences plus the complete generated project index. Use \"preferences\" for the full user preferences, \"index\" for the full project index, or an exact project topic matching /^[a-zA-Z0-9_]+$/. No scope parameter is accepted."),
  })
  .strict();

type MemoryReadInput = z.infer<typeof MemoryReadInputSchema>;

// ─── Helpers ───

const NAME_REGEX = /^[a-zA-Z0-9_]+$/;

function memoryReadFailure(error: unknown): RawToolResult {
  if (error instanceof BoundedFileReadError) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_OUTPUT_POLICY_VIOLATION",
      message: `Memory file exceeds the ${ONE_SHOT_FILE_READ_MAX_BYTES}-byte one-shot read limit`,
      name: error.name,
    });
  }
  if (error instanceof MemoryPathError) {
    return createToolErrorResult({
      kind: "workspace",
      code: "TOOL_FILE_OUTSIDE_WORKSPACE",
      message: "Memory path is outside the configured Memory roots",
    });
  }
  return createToolErrorResult({
    kind: "execution",
    code: "TOOL_MEMORY_READ_FAILED",
    message: "Memory could not be read",
  });
}

// ─── Combined context (no-arg call) ───

async function buildCombinedContext(
  memory: MemoryService,
): Promise<string> {
  const parts: string[] = [];
  parts.push(MEMORY_CONTEXT_START);

  const manifest = await memory.readPromptManifest();
  if (manifest.preferences?.availableForPrompt) {
    parts.push(PREFERENCES_MARKER_START);
    parts.push(manifest.preferences.content);
    parts.push(PREFERENCES_MARKER_END);
  } else if (manifest.preferences?.capacity.state === "over-limit") {
    parts.push("Personal Memory is over capacity and omitted. Manage it in Settings → Memory.");
  }

  const indexContent = manifest.index.availableForPrompt
    ? manifest.index.content
    : null;
  if (indexContent !== null) {
    parts.push("## Memory Index");
    parts.push(indexContent);
  } else if (!manifest.index.availableForPrompt) {
    parts.push("Project Memory index is over capacity and omitted. Manage it in Settings → Memory.");
  }

  parts.push(MEMORY_CONTEXT_END);

  return parts.join("\n\n");
}

// ─── Topic file reader ───

async function readTopicFile(
  memory: MemoryService,
  name: string,
): Promise<RawToolResult> {
  if (!NAME_REGEX.test(name)) {
    return createToolErrorResult({
      kind: "workspace",
      code: "TOOL_MEMORY_INVALID_NAME",
      message: `Invalid memory name: "${name}". Name must match /^[a-zA-Z0-9_]+$/.`,
    });
  }

  try {
    const topic = await memory.readTopic(name);
    if (topic === null) {
      return createToolErrorResult({
        kind: "file-not-found",
        code: "TOOL_FILE_NOT_FOUND",
        message: `Memory file not found: ${name}`,
      });
    }

    const header = `---\nname: ${topic.title}\ndescription: ${topic.description}\ntype: ${topic.type}\n---`;
    return createTextToolResult([MEMORY_CONTEXT_START, header, topic.content, MEMORY_CONTEXT_END].join("\n"));
  } catch (error) {
    // Frontmatter parsing failed — return structured error instead of falling back to raw content
    return memoryReadFailure(error);
  }
}

// ─── Tool Definition (factory) ───

export function createMemoryReadTool() {
  return defineTool({
    name: "memory_read",
    description:
      "Read persisted Memory when prior work, existing decisions, user preferences, project conventions, an unfamiliar module, or context lost after compaction may matter. " +
      "Omit name to receive complete in-capacity user preferences plus the complete project memory index. " +
      'Use "preferences" for the full user preference file, "index" for the full project index, or an exact project knowledge topic name. ' +
      "This tool reads known entries and does not perform semantic search; read the index first when the topic name is unknown.",
    inputSchema: MemoryReadInputSchema,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
    execute: async (
      input: MemoryReadInput,
      ctx: ToolExecutionContext,
    ) => {
      try {
        const memory = ctx.projectContext.memory;
        if (!input.name) {
          return createTextToolResult(await buildCombinedContext(memory));
        }

        if (input.name === "preferences") {
          const preferences = await memory.readPreferences();
          if (preferences === null) {
            return createToolErrorResult({
              kind: "file-not-found",
              code: "TOOL_FILE_NOT_FOUND",
              message: "Memory preferences not found",
            });
          }
          return createTextToolResult(preferences.content);
        }

        if (input.name === "index") {
          const content = await memory.readIndex();
          if (content === null) {
            return createToolErrorResult({
              kind: "file-not-found",
              code: "TOOL_FILE_NOT_FOUND",
              message: "Memory index not found",
            });
          }
          return createTextToolResult(content);
        }

        return await readTopicFile(memory, input.name);
      } catch (error) {
        return memoryReadFailure(error);
      }
    },
  });
}
