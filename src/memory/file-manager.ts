import { mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { MemoryIndexEntry, MemoryRoots, MemoryTopicFile } from "./types";
import type { MemoryFrontmatter } from "./schemas";
import { MemoryFrontmatterSchema } from "./schemas";
import {
  INDEX_FILE,
  KNOWLEDGE_DIR_NAME,
  MEMORY_DIR_NAME,
  PREFERENCES_FILE,
} from "./constants";

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

export class MemoryPathError extends Error {
  public readonly path: string;
  public readonly reason: string;

  constructor(path: string, reason: string) {
    super(`Memory path error: ${reason} (path: "${path}")`);
    this.name = "MemoryPathError";
    this.path = path;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `.tmp-${crypto.randomUUID()}`);
  try {
    await Bun.write(tmpPath, content);
  } catch (err) {
    // Clean up temp file on write failure
    try {
      await rm(tmpPath);
    } catch {
      // Best-effort cleanup
    }
    throw new Error(
      `Failed to write temp file "${tmpPath}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on rename failure
    try {
      await rm(tmpPath);
    } catch {
      // Best-effort cleanup
    }
    throw new Error(
      `Failed to rename "${tmpPath}" to "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

const FRONTMATTER_DELIMITER = "---";

export function parseFrontmatter(content: string): {
  frontmatter: MemoryFrontmatter;
  body: string;
} {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith(FRONTMATTER_DELIMITER)) {
    throw new Error("Content does not start with frontmatter delimiter '---'");
  }

  // Skip opening delimiter
  const afterOpen = trimmed.slice(FRONTMATTER_DELIMITER.length);

  // Find closing delimiter
  const closeIndex = afterOpen.indexOf(`\n${FRONTMATTER_DELIMITER}`);
  if (closeIndex === -1) {
    throw new Error("No closing frontmatter delimiter found");
  }

  const yamlBlock = afterOpen.slice(0, closeIndex);
  const body = afterOpen.slice(
    closeIndex + 1 + FRONTMATTER_DELIMITER.length,
  ).trimStart();

  // Parse YAML manually (simple key: value format)
  const parsed = parseSimpleYaml(yamlBlock);
  const frontmatter = MemoryFrontmatterSchema.parse(parsed);

  return { frontmatter, body };
}

export function formatFrontmatter(
  frontmatter: MemoryFrontmatter,
  body: string,
): string {
  const yaml = formatSimpleYaml(frontmatter);
  return `${FRONTMATTER_DELIMITER}\n${yaml}\n${FRONTMATTER_DELIMITER}\n${body}`;
}

// ---------------------------------------------------------------------------
// Simple YAML parser/formatter (avoids adding a dependency)
// ---------------------------------------------------------------------------

function parseSimpleYaml(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    result[key] = value;
  }
  return result;
}

function formatSimpleYaml(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Index parsing
// ---------------------------------------------------------------------------

const INDEX_LINE_REGEX = /^- \[(.+?)\]\((.+?)\) — (.+)$/;

export function parseIndex(content: string): MemoryIndexEntry[] {
  const entries: MemoryIndexEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = trimmed.match(INDEX_LINE_REGEX);
    if (match) {
      entries.push({
        title: match[1],
        name: match[2],
        summary: match[3],
      });
    }
  }
  return entries;
}

export function formatIndex(entries: MemoryIndexEntry[]): string {
  const lines = entries.map(
    (e) => `- [${e.title}](${e.name}) — ${e.summary}`,
  );
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// MemoryFileManager
// ---------------------------------------------------------------------------

export class MemoryFileManager {
  public readonly projectRoot: string;
  public readonly userRoot: string;

  constructor(roots: MemoryRoots) {
    this.projectRoot = resolve(roots.project);
    this.userRoot = resolve(roots.user);
  }

  // -------------------------------------------------------------------------
  // Path validation
  // -------------------------------------------------------------------------

  async resolveProjectPath(relative: string): Promise<string> {
    return this.#resolvePath(relative, this.projectRoot);
  }

  async resolveUserPath(relative: string): Promise<string> {
    return this.#resolvePath(relative, this.userRoot);
  }

  async #resolvePath(relative: string, root: string): Promise<string> {
    // Reject absolute paths
    if (resolve(relative) === relative && !relative.startsWith(".")) {
      throw new MemoryPathError(relative, "Absolute paths are not allowed");
    }

    // Reject path traversal
    const normalized = resolve(root, relative);
    if (!this.isContained(normalized, root)) {
      throw new MemoryPathError(
        relative,
        "Path escapes the allowed root directory",
      );
    }

    // Resolve symlinks and reject if they point outside root
    const realPath = await this.#resolveSymlinkSafe(normalized, root);
    return realPath;
  }

  async #resolveSymlinkSafe(resolvedPath: string, root: string): Promise<string> {
    try {
      const realPath = await realpath(resolvedPath);
      if (!this.isContained(realPath, root)) {
        throw new MemoryPathError(
          resolvedPath,
          "Symlink resolves outside the allowed root directory",
        );
      }
      return realPath;
    } catch (error) {
      if (error instanceof MemoryPathError) throw error;
      // If the file doesn't exist yet, realpath will fail — that's fine,
      // the path itself is already validated above.
      return resolvedPath;
    }
  }

  isContained(resolvedPath: string, root: string): boolean {
    const normalizedResolved = resolve(resolvedPath);
    const normalizedRoot = resolve(root);
    // Ensure the resolved path starts with the root (with trailing separator for exact match)
    return (
      normalizedResolved === normalizedRoot ||
      normalizedResolved.startsWith(normalizedRoot + "/")
    );
  }

  // -------------------------------------------------------------------------
  // Read methods
  // -------------------------------------------------------------------------

  async readIndex(): Promise<string | null> {
    const indexPath = join(this.projectRoot, INDEX_FILE);
    return this.#readFileOrNull(indexPath);
  }

  async readPreferences(scope: "project" | "user"): Promise<string | null> {
    const root = scope === "project" ? this.projectRoot : this.userRoot;
    const prefPath = join(root, PREFERENCES_FILE);
    return this.#readFileOrNull(prefPath);
  }

  async readTopic(name: string): Promise<MemoryTopicFile | null> {
    const resolvedPath = await this.resolveProjectPath(
      join(KNOWLEDGE_DIR_NAME, `${name}.md`),
    );
    const content = await this.#readFileOrNull(resolvedPath);
    if (content === null) return null;

    const { frontmatter, body } = parseFrontmatter(content);
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      type: frontmatter.type,
      content: body,
      filePath: resolvedPath,
    };
  }

  async listTopics(): Promise<string[]> {
    const knowledgeDir = join(this.projectRoot, KNOWLEDGE_DIR_NAME);
    try {
      const entries = await readdir(knowledgeDir);
      return entries
        .filter((e) => e.endsWith(".md"))
        .map((e) => e.slice(0, -3)) // Strip .md extension
        .sort();
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Write methods (all atomic)
  // -------------------------------------------------------------------------

  async writeTopic(
    name: string,
    frontmatter: MemoryFrontmatter,
    content: string,
    scope: "project" | "user" = "project",
  ): Promise<void> {
    const resolvedPath =
      scope === "project"
        ? await this.resolveProjectPath(join(KNOWLEDGE_DIR_NAME, `${name}.md`))
        : await this.resolveUserPath(join(KNOWLEDGE_DIR_NAME, `${name}.md`));
    const fileContent = formatFrontmatter(frontmatter, content);
    await atomicWrite(resolvedPath, fileContent);
  }

  async writePreferences(
    scope: "project" | "user",
    content: string,
  ): Promise<void> {
    const root = scope === "project" ? this.projectRoot : this.userRoot;
    const prefPath = join(root, PREFERENCES_FILE);
    await atomicWrite(prefPath, content);
  }

  async writeIndex(entries: MemoryIndexEntry[]): Promise<void> {
    const existingTopics = await this.listTopics();
    const existingPaths = new Set(
      existingTopics.map((t) => join(KNOWLEDGE_DIR_NAME, `${t}.md`)),
    );
    const validEntries = entries.filter((e) =>
      existingPaths.has(join(KNOWLEDGE_DIR_NAME, `${e.name}.md`)),
    );
    const content = formatIndex(validEntries);
    const indexPath = join(this.projectRoot, INDEX_FILE);
    await atomicWrite(indexPath, content);
  }

  async rebuildIndex(): Promise<void> {
    const topics = await this.listTopics();
    const entries: MemoryIndexEntry[] = [];

    for (const topicFile of topics) {
      const topicPath = join(KNOWLEDGE_DIR_NAME, `${topicFile}.md`);
      const resolvedPath = await this.resolveProjectPath(topicPath);
      const content = await this.#readFileOrNull(resolvedPath);
      if (content === null) continue;

      try {
        const { frontmatter } = parseFrontmatter(content);
        entries.push({
          title: frontmatter.name,
          name: topicFile,
          summary: frontmatter.description,
        });
      } catch {
        // Skip files with invalid frontmatter
      }
    }

    await this.writeIndex(entries);
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  searchIndex(query: string, entries: MemoryIndexEntry[]): MemoryIndexEntry[] {
    const lowerQuery = query.toLowerCase();
    const seen = new Set<string>();
    const results: MemoryIndexEntry[] = [];

    for (const entry of entries) {
      if (seen.has(entry.name)) continue;
      if (
        entry.title.toLowerCase().includes(lowerQuery) ||
        entry.summary.toLowerCase().includes(lowerQuery)
      ) {
        seen.add(entry.name);
        results.push(entry);
        if (results.length >= 20) break;
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  async #readFileOrNull(filePath: string): Promise<string | null> {
    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) return null;
      return await file.text();
    } catch {
      return null;
    }
  }
}