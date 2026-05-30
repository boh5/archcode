import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { buildSystemPrompt } from "../builder";
import type { PromptContext } from "../types";
import {
  DEFAULT_MAX_PREFERENCES_BYTES,
} from "../../memory/constants";
import type { MemoryRoots } from "../../memory/types";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import crypto from "node:crypto";

const TEST_TMP = join(import.meta.dir, "__test_tmp__");

function makeCtx(overrides?: Partial<PromptContext>): PromptContext {
  return { allowedTools: ["file_read", "file_write"],
  workspaceRoot: "/home/user/project",
  promptProfileId: "default",
  env: {
    platform: "darwin",
    timezone: "America/Los_Angeles",
    locale: "en-US",
    cwd: "/home/user/project",
    date: "2025-01-15",
  }, ...overrides,  };
}

async function createMemoryDirs(): Promise<MemoryRoots> {
  const id = crypto.randomUUID();
  const projectRoot = join(TEST_TMP, id, "project", "memory");
  const userRoot = join(TEST_TMP, id, "user", "memory");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(userRoot, { recursive: true });
  return { project: projectRoot, user: userRoot };
}

async function writeMemoryFile(
  roots: MemoryRoots,
  scope: "project" | "user",
  filename: string,
  content: string,
): Promise<void> {
  const root = scope === "project" ? roots.project : roots.user;
  const filePath = join(root, filename);
  await mkdir(join(root), { recursive: true });
  await Bun.write(filePath, content);
}

describe("buildSystemPrompt — Memory section", () => {
  beforeEach(async () => {
    await mkdir(TEST_TMP, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_TMP, { recursive: true, force: true }).catch(() => {});
  });

  test("omits Memory section when memoryRoots is undefined", async () => {
    const result = await buildSystemPrompt(makeCtx());
    expect(result).not.toContain("## Memory");
  });

  test("omits Memory section when all memory files are missing", async () => {
    const roots = await createMemoryDirs();
    const result = await buildSystemPrompt(
      makeCtx({ memoryRoots: roots }),
    );
    expect(result).not.toContain("## Memory");
  });

  test("includes Memory section with index only", async () => {
    const roots = await createMemoryDirs();
    await writeMemoryFile(roots, "project", "index.md", "# Memory Index\n- [Topic](knowledge/topic.md) — A topic\n");

    const result = await buildSystemPrompt(
      makeCtx({ memoryRoots: roots }),
    );
    expect(result).toContain("## Memory");
    expect(result).toContain("<specra-memory-context>");
    expect(result).toContain("</specra-memory-context>");
    expect(result).not.toContain("<specra-memory-preferences>");
  });

  test("includes Memory section with user preferences only", async () => {
    const roots = await createMemoryDirs();
    await writeMemoryFile(roots, "user", "preferences.md", "I prefer dark mode");

    const result = await buildSystemPrompt(
      makeCtx({ memoryRoots: roots }),
    );
    expect(result).toContain("## Memory");
    expect(result).toContain("<specra-memory-preferences>");
    expect(result).toContain("I prefer dark mode");
    expect(result).toContain("</specra-memory-preferences>");
    expect(result).not.toContain("<specra-memory-context>");
  });

  test("includes all memory sections when both user preferences and index exist", async () => {
    const roots = await createMemoryDirs();
    await writeMemoryFile(roots, "project", "index.md", "# Index\n- [A](a.md) — desc\n");
    await writeMemoryFile(roots, "user", "preferences.md", "User pref");

    const result = await buildSystemPrompt(
      makeCtx({ memoryRoots: roots }),
    );
    expect(result).toContain("<specra-memory-preferences>");
    expect(result).toContain("<specra-memory-context>");
  });

  test("injection order: user preferences → index", async () => {
    const roots = await createMemoryDirs();
    await writeMemoryFile(roots, "project", "index.md", "INDEX_CONTENT");
    await writeMemoryFile(roots, "user", "preferences.md", "USER_PREF");

    const result = await buildSystemPrompt(
      makeCtx({ memoryRoots: roots }),
    );
    const userPrefIdx = result.indexOf("<specra-memory-preferences>");
    const contextIdx = result.indexOf("<specra-memory-context>");

    expect(userPrefIdx).toBeLessThan(contextIdx);
  });

  test("Memory section appears between Environment and Project Context", async () => {
    const roots = await createMemoryDirs();
    await writeMemoryFile(roots, "project", "index.md", "Some index");

    const result = await buildSystemPrompt(
      makeCtx({ memoryRoots: roots, agentsMd: "AGENTSCONTENT" }),
    );
    const envIdx = result.indexOf("## Environment");
    const memoryIdx = result.indexOf("## Memory");
    const projectIdx = result.indexOf("## Project Context");

    expect(envIdx).toBeLessThan(memoryIdx);
    expect(memoryIdx).toBeLessThan(projectIdx);
  });

  test("includes memory tools description", async () => {
    const roots = await createMemoryDirs();
    await writeMemoryFile(roots, "project", "index.md", "Some index");

    const result = await buildSystemPrompt(
      makeCtx({ memoryRoots: roots }),
    );
    expect(result).toContain("memory_read");
    expect(result).toContain("memory_write");
  });

  test("truncates index at DEFAULT_MAX_INDEX_LINES", async () => {
    const roots = await createMemoryDirs();
    const lines = Array.from({ length: 300 }, (_, i) => `- [Topic${i}](knowledge/t${i}.md) — Desc ${i}`);
    await writeMemoryFile(roots, "project", "index.md", lines.join("\n"));

    const result = await buildSystemPrompt(
      makeCtx({
        memoryRoots: roots,
      }),
    );
    expect(result).toContain("Memory index truncated");
  });

  test("uses default maxIndexLines when memoryConfig not provided", async () => {
    const roots = await createMemoryDirs();
    const lines = Array.from({ length: 250 }, (_, i) => `- [Topic${i}](knowledge/t${i}.md) — Desc ${i}`);
    await writeMemoryFile(roots, "project", "index.md", lines.join("\n"));

    const result = await buildSystemPrompt(
      makeCtx({ memoryRoots: roots }),
    );
    expect(result).toContain("Memory index truncated");
  });

  test("does not truncate index when within limit", async () => {
    const roots = await createMemoryDirs();
    const lines = Array.from({ length: 50 }, (_, i) => `- [Topic${i}](knowledge/t${i}.md) — Desc ${i}`);
    await writeMemoryFile(roots, "project", "index.md", lines.join("\n"));

    const result = await buildSystemPrompt(
      makeCtx({ memoryRoots: roots }),
    );
    expect(result).not.toContain("Memory index truncated");
    expect(result).toContain("Topic49");
  });

  test("truncates preferences at DEFAULT_MAX_PREFERENCES_BYTES and appends warning", async () => {
    const roots = await createMemoryDirs();
    const longPref = "x".repeat(30000);
    await writeMemoryFile(roots, "user", "preferences.md", longPref);

    const result = await buildSystemPrompt(
      makeCtx({
        memoryRoots: roots,
      }),
    );
    const startTag = "<specra-memory-preferences>\n";
    const endTag = "\n</specra-memory-preferences>";
    const startIdx = result.indexOf(startTag) + startTag.length;
    const endIdx = result.indexOf(endTag, startIdx);
    const content = result.slice(startIdx, endIdx);
    const encoder = new TextEncoder();
    expect(result).toContain("<!-- preferences truncated -->");
    expect(encoder.encode(content).length).toBeLessThanOrEqual(DEFAULT_MAX_PREFERENCES_BYTES + 100);
  });

  test("does not append truncation warning when preferences fit within limit", async () => {
    const roots = await createMemoryDirs();
    await writeMemoryFile(roots, "user", "preferences.md", "Short preference");

    const result = await buildSystemPrompt(
      makeCtx({
        memoryRoots: roots,
      }),
    );
    expect(result).not.toContain("<!-- preferences truncated -->");
  });

  test("gracefully handles missing index file", async () => {
    const roots = await createMemoryDirs();
    await writeMemoryFile(roots, "user", "preferences.md", "Some pref");

    const result = await buildSystemPrompt(
      makeCtx({ memoryRoots: roots }),
    );
    expect(result).toContain("## Memory");
    expect(result).toContain("<specra-memory-preferences>");
    expect(result).not.toContain("<specra-memory-context>");
  });

  test("gracefully handles missing preferences files", async () => {
    const roots = await createMemoryDirs();
    await writeMemoryFile(roots, "project", "index.md", "# Index\n- [A](a.md) — desc\n");

    const result = await buildSystemPrompt(
      makeCtx({ memoryRoots: roots }),
    );
    expect(result).toContain("## Memory");
    expect(result).toContain("<specra-memory-context>");
    expect(result).not.toContain("<specra-memory-preferences>");
  });
});