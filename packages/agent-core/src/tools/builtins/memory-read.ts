import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";
import {
  DEFAULT_MAX_INDEX_LINES,
  DEFAULT_MAX_PREFERENCES_BYTES,
  INDEX_TRUNCATION_SUFFIX,
  MEMORY_CONTEXT_END,
  MEMORY_CONTEXT_START,
  MemoryFileManager,
  MemoryPathError,
  PREFERENCES_MARKER_END,
  PREFERENCES_MARKER_START,
} from "../../memory";

// ─── Input Schema ───

const MemoryReadInputSchema = z
  .object({
    name: z.string().optional().describe("Omit for combined truncated context. Use \"preferences\" for full user preferences, \"index\" for the full project index, or an exact project topic matching /^[a-zA-Z0-9_]+$/. No scope parameter is accepted."),
  })
  .strict();

type MemoryReadInput = z.infer<typeof MemoryReadInputSchema>;

// ─── Helpers ───

const NAME_REGEX = /^[a-zA-Z0-9_]+$/;

function truncateIndex(content: string, maxLines: number): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  return lines.slice(0, maxLines).join("\n") + INDEX_TRUNCATION_SUFFIX;
}

function truncatePreferences(content: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  if (bytes.length <= maxBytes) return content;
  return new TextDecoder().decode(bytes.slice(0, maxBytes));
}

// ─── Combined context (no-arg call) ───

async function buildCombinedContext(
  fileManager: MemoryFileManager,
): Promise<string> {
  const parts: string[] = [];
  parts.push(MEMORY_CONTEXT_START);

  const userPrefs = await fileManager.readPreferences();
  if (userPrefs !== null) {
    const truncated = truncatePreferences(userPrefs, DEFAULT_MAX_PREFERENCES_BYTES);
    parts.push(PREFERENCES_MARKER_START);
    parts.push(truncated);
    parts.push(PREFERENCES_MARKER_END);
  }

  const indexContent = await fileManager.readIndex();
  if (indexContent !== null) {
    const truncated = truncateIndex(indexContent, DEFAULT_MAX_INDEX_LINES);
    parts.push("## Memory Index");
    parts.push(truncated);
  }

  parts.push(MEMORY_CONTEXT_END);

  return parts.join("\n\n");
}

// ─── Topic file reader ───

async function readTopicFile(
  fileManager: MemoryFileManager,
  name: string,
): Promise<string | ToolExecutionResult> {
  if (!NAME_REGEX.test(name)) {
    return createToolErrorResult({
      kind: "workspace",
      code: "TOOL_MEMORY_INVALID_NAME",
      message: `Invalid memory name: "${name}". Name must match /^[a-zA-Z0-9_]+$/.`,
    });
  }

  try {
    const topic = await fileManager.readTopic(name);
    if (topic === null) {
      return createToolErrorResult({
        kind: "file-not-found",
        code: "TOOL_FILE_NOT_FOUND",
        message: `Memory file not found: ${name}`,
      });
    }

    const header = `---\nname: ${topic.name}\ndescription: ${topic.description}\ntype: ${topic.type}\n---`;
    return [MEMORY_CONTEXT_START, header, topic.content, MEMORY_CONTEXT_END].join("\n");
  } catch (error) {
    if (error instanceof MemoryPathError) {
      return createToolErrorResult({
        kind: "workspace",
        code: "TOOL_FILE_OUTSIDE_WORKSPACE",
        message: error.message,
      });
    }

    // Frontmatter parsing failed — return structured error instead of falling back to raw content
    return createToolErrorResult({
      kind: "execution",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

// ─── Tool Definition (factory) ───

export function createMemoryReadTool(): AnyToolDescriptor {
  return defineTool({
    name: "memory_read",
    description:
      "Read persisted Memory when prior work, existing decisions, user preferences, project conventions, an unfamiliar module, or context lost after compaction may matter. " +
      "Omit name to receive truncated user preferences plus the project memory index. " +
      'Use "preferences" for the full user preference file, "index" for the full project index, or an exact project knowledge topic name. ' +
      "This tool reads known entries and does not perform semantic search; read the index first when the topic name is unknown.",
    inputSchema: MemoryReadInputSchema,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async (
      input: MemoryReadInput,
      ctx: ToolExecutionContext,
    ): Promise<string | ToolExecutionResult> => {
      const fileManager = ctx.projectContext.memory;
      if (!input.name) {
        return buildCombinedContext(fileManager);
      }

      if (input.name === "preferences") {
        const content = await fileManager.readPreferences();
        if (content === null) {
          return createToolErrorResult({
            kind: "file-not-found",
            code: "TOOL_FILE_NOT_FOUND",
            message: "Memory preferences not found",
          });
        }
        return content;
      }

      if (input.name === "index") {
        const content = await fileManager.readIndex();
        if (content === null) {
          return createToolErrorResult({
            kind: "file-not-found",
            code: "TOOL_FILE_NOT_FOUND",
            message: "Memory index not found",
          });
        }
        return content;
      }

      return readTopicFile(fileManager, input.name);
    },
  });
}
