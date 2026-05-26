import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MemoryIndexEntry, MemoryRoots, MemoryTopicFile } from "./types";
import type { MemoryFrontmatter } from "./schemas";
import { MemoryFrontmatterSchema } from "./schemas";
import {
  atomicWrite,
  isContained,
  resolveContainedPath,
  SafePathError,
} from "../utils/safe-file";
import {
  formatFrontmatter as formatGenericFrontmatter,
  formatSimpleYaml,
  parseFrontmatter as parseGenericFrontmatter,
  parseSimpleYaml,
} from "../utils/frontmatter";
import {
  INDEX_FILE,
  KNOWLEDGE_DIR_NAME,
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
// Frontmatter parsing
// ---------------------------------------------------------------------------

export function parseFrontmatter(content: string): {
  frontmatter: MemoryFrontmatter;
  body: string;
} {
  const { frontmatter: parsed, body } = parseGenericFrontmatter(content);
  const frontmatter = MemoryFrontmatterSchema.parse(parsed);

  return { frontmatter, body };
}

export function formatFrontmatter(
  frontmatter: MemoryFrontmatter,
  body: string,
): string {
  return formatGenericFrontmatter(frontmatter, body);
}

export { formatSimpleYaml, parseSimpleYaml };

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
    try {
      return await resolveContainedPath(relative, root);
    } catch (error) {
      if (error instanceof SafePathError) {
        throw new MemoryPathError(error.path, error.reason);
      }
      throw error;
    }
  }

  isContained(resolvedPath: string, root: string): boolean {
    return isContained(resolvedPath, root);
  }

  // -------------------------------------------------------------------------
  // Read methods
  // -------------------------------------------------------------------------

  async readIndex(): Promise<string | null> {
    const indexPath = join(this.projectRoot, INDEX_FILE);
    return this.#readFileOrNull(indexPath);
  }

  async readPreferences(): Promise<string | null> {
    const prefPath = join(this.userRoot, PREFERENCES_FILE);
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
  ): Promise<void> {
    const resolvedPath = await this.resolveProjectPath(join(KNOWLEDGE_DIR_NAME, `${name}.md`));
    const fileContent = formatFrontmatter(frontmatter, content);
    await atomicWrite(resolvedPath, fileContent);
  }

  async writePreferences(content: string): Promise<void> {
    const prefPath = join(this.userRoot, PREFERENCES_FILE);
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

  async readTopicContent(name: string): Promise<string | null> {
    const resolvedPath = await this.resolveProjectPath(
      join(KNOWLEDGE_DIR_NAME, `${name}.md`),
    );
    return this.#readFileOrNull(resolvedPath);
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
