import { z } from "zod";
import { join } from "node:path";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";
import {
  DEFAULT_MAX_INDEX_LINES,
  DEFAULT_MAX_PREFERENCES_BYTES,
  INDEX_FILE,
  INDEX_TRUNCATION_SUFFIX,
  KNOWLEDGE_DIR_NAME,
  MEMORY_CONTEXT_END,
  MEMORY_CONTEXT_START,
  MemoryFileManager,
  MemoryPathError,
  PREFERENCES_FILE,
  PREFERENCES_MARKER_END,
  PREFERENCES_MARKER_START,
  parseFrontmatter,
  PROJECT_PREFERENCES_MARKER_END,
  PROJECT_PREFERENCES_MARKER_START,
} from "../../memory";

// ─── Input Schema ───

const MemoryReadInputSchema = z
  .object({
    name: z.string().optional(),
    scope: z.enum(["project", "user", "both"]).default("both"),
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
  scope: "project" | "user" | "both",
): Promise<string> {
  const parts: string[] = [];
  parts.push(MEMORY_CONTEXT_START);

  // Order: user preferences → project preferences → index
  if (scope === "user" || scope === "both") {
    const userPrefs = await fileManager.readPreferences("user");
    if (userPrefs !== null) {
      const truncated = truncatePreferences(userPrefs, DEFAULT_MAX_PREFERENCES_BYTES);
      parts.push(PREFERENCES_MARKER_START);
      parts.push(truncated);
      parts.push(PREFERENCES_MARKER_END);
    }
  }

  if (scope === "project" || scope === "both") {
    const projectPrefs = await fileManager.readPreferences("project");
    if (projectPrefs !== null) {
      const truncated = truncatePreferences(projectPrefs, DEFAULT_MAX_PREFERENCES_BYTES);
      parts.push(PROJECT_PREFERENCES_MARKER_START);
      parts.push(truncated);
      parts.push(PROJECT_PREFERENCES_MARKER_END);
    }
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
    const resolvedPath = await fileManager.resolveProjectPath(
      join(KNOWLEDGE_DIR_NAME, `${name}.md`),
    );

    const file = Bun.file(resolvedPath);
    const exists = await file.exists();
    if (!exists) {
      return createToolErrorResult({
        kind: "file-not-found",
        code: "TOOL_FILE_NOT_FOUND",
        message: `Memory file not found: ${name}`,
      });
    }

    const content = await file.text();

    try {
      const { frontmatter, body } = parseFrontmatter(content);
      const header = `---\nname: ${frontmatter.name}\ndescription: ${frontmatter.description}\ntype: ${frontmatter.type}\n---`;
      return [MEMORY_CONTEXT_START, header, body, MEMORY_CONTEXT_END].join("\n");
    } catch {
      return content;
    }
  } catch (error) {
    if (error instanceof MemoryPathError) {
      return createToolErrorResult({
        kind: "workspace",
        code: "TOOL_FILE_OUTSIDE_WORKSPACE",
        message: error.message,
      });
    }
    return createToolErrorResult({
      kind: "execution",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

// ─── Single-file raw reader ───

async function readRawFile(path: string): Promise<string | null> {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) return null;
  return await file.text();
}

// ─── Tool Definition (factory) ───

export function createMemoryReadTool(
  fileManager: MemoryFileManager,
): AnyToolDescriptor {
  return defineTool({
    name: "memory_read",
    description:
      "Reads structured memory context. " +
      "When called without a name, returns a combined context of index and preferences. " +
      'Special names: "preferences" reads project preferences, "index" reads the memory index. ' +
      "Otherwise, name identifies a knowledge topic (letters, numbers, underscores only).",
    inputSchema: MemoryReadInputSchema,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async (
      input: MemoryReadInput,
      _ctx: ToolExecutionContext,
    ): Promise<string | ToolExecutionResult> => {
      if (!input.name) {
        return buildCombinedContext(fileManager, input.scope ?? "both");
      }

      if (input.name === "preferences") {
        const projectPrefsPath = join(fileManager.projectRoot, PREFERENCES_FILE);
        const content = await readRawFile(projectPrefsPath);
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
        const indexPath = join(fileManager.projectRoot, INDEX_FILE);
        const content = await readRawFile(indexPath);
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
