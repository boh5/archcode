import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PROJECT_STATE_DIR_NAME } from "@archcode/protocol";

import type { MemoryFrontmatter } from "../memory/schemas";
import type { MemoryIndexEntry, MemoryTopicFile } from "../memory/types";
import {
  formatFrontmatter,
  formatIndex,
  parseFrontmatter,
} from "../memory/file-manager";
import { INDEX_FILE, KNOWLEDGE_DIR_NAME, PREFERENCES_FILE } from "../memory/constants";
import { atomicWrite, resolveContainedPath, SafePathError } from "../utils/safe-file";
import { GoalUuidSchema } from "./state";

const GOAL_MEMORY_NAME_REGEX = /^[a-zA-Z0-9_]+$/;
const INDEX_NAME = INDEX_FILE.replace(".md", "");
const PREFERENCES_NAME = PREFERENCES_FILE.replace(".md", "");

export class GoalMemoryNameError extends Error {
  constructor(public readonly name: string) {
    super(`Invalid goal memory topic name: ${name}`);
    this.name = "GoalMemoryNameError";
  }
}

export class GoalMemoryPathError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`Invalid goal memory path: ${reason} (path: "${path}")`);
    this.name = "GoalMemoryPathError";
  }
}

export class GoalMemoryManager {
  constructor(public readonly workspaceRoot: string) {}

  async readIndex(goalId: string): Promise<string | null> {
    const indexPath = await this.memoryPath(goalId, INDEX_FILE);
    return await readFileOrNull(indexPath);
  }

  async readTopic(goalId: string, name: string): Promise<MemoryTopicFile | null> {
    const safeName = this.parseTopicName(name);
    const topicPath = await this.memoryPath(goalId, join(KNOWLEDGE_DIR_NAME, `${safeName}.md`));
    const content = await readFileOrNull(topicPath);
    if (content === null) return null;

    const { frontmatter, body } = parseFrontmatter(content);
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      type: frontmatter.type,
      content: body,
      filePath: topicPath,
    };
  }

  async listTopics(goalId: string): Promise<string[]> {
    const dir = await this.memoryPath(goalId, KNOWLEDGE_DIR_NAME);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name.slice(0, -3))
        .filter((name) => this.isValidTopicName(name))
        .sort();
    } catch (error) {
      if (isMissingDirectoryError(error)) return [];
      throw error;
    }
  }

  async writeTopic(
    goalId: string,
    name: string,
    frontmatter: MemoryFrontmatter,
    content: string,
  ): Promise<void> {
    const safeName = this.parseTopicName(name);
    const topicPath = await this.memoryPath(goalId, join(KNOWLEDGE_DIR_NAME, `${safeName}.md`));
    await atomicWrite(topicPath, formatFrontmatter(frontmatter, normalizeMarkdown(content)));
    await this.rebuildIndex(goalId);
  }

  async rebuildIndex(goalId: string): Promise<void> {
    const entries: MemoryIndexEntry[] = [];
    for (const topicName of await this.listTopics(goalId)) {
      const topic = await this.readTopic(goalId, topicName);
      if (topic === null) continue;
      entries.push({
        title: topic.name,
        name: topicName,
        summary: topic.description,
      });
    }

    const indexPath = await this.memoryPath(goalId, INDEX_FILE);
    await atomicWrite(indexPath, formatIndex(entries));
  }

  async resolveMemoryPathForTest(goalId: string, relative: string): Promise<string> {
    return await this.memoryPath(goalId, relative);
  }

  private parseTopicName(name: string): string {
    if (!this.isValidTopicName(name)) throw new GoalMemoryNameError(name);
    return name;
  }

  private isValidTopicName(name: string): boolean {
    return GOAL_MEMORY_NAME_REGEX.test(name) && name !== INDEX_NAME && name !== PREFERENCES_NAME;
  }

  private async memoryPath(goalId: string, relative: string): Promise<string> {
    const parsedGoalId = GoalUuidSchema.safeParse(goalId);
    if (!parsedGoalId.success) throw new GoalMemoryPathError(goalId, "Goal id must be a UUID");

    try {
      return await resolveContainedPath(
        join(parsedGoalId.data, "memory", relative),
        this.goalsRoot(),
      );
    } catch (error) {
      if (error instanceof SafePathError) throw new GoalMemoryPathError(error.path, error.reason);
      throw error;
    }
  }

  private goalsRoot(): string {
    return resolve(this.workspaceRoot, PROJECT_STATE_DIR_NAME, "goals");
  }
}

function normalizeMarkdown(content: string): string {
  return `${content.trimEnd()}\n`;
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    return await file.text();
  } catch {
    return null;
  }
}

function isMissingDirectoryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
