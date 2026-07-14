import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdir, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  MemoryFileManager,
  MemoryPathError,
  parseFrontmatter,
  formatFrontmatter,
  parseIndex,
  formatIndex,
} from "./file-manager";
import type { MemoryIndexEntry } from "./types";
import type { MemoryFrontmatter } from "./schemas";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "file-manager", crypto.randomUUID());

function makeManager(): MemoryFileManager {
  return new MemoryFileManager({
    project: join(TMP_DIR, "project", ".archcode", "memory"),
    user: join(TMP_DIR, "user", ".archcode", "memory"),
  });
}

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(join(TMP_DIR, "project", ".archcode", "memory"), { recursive: true });
  await mkdir(join(TMP_DIR, "user", ".archcode", "memory"), { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// MemoryPathError
// ---------------------------------------------------------------------------

describe("MemoryPathError", () => {
  test("has correct name, message, and fields", () => {
    const err = new MemoryPathError("../../etc/passwd", "Path escapes root");
    expect(err.name).toBe("MemoryPathError");
    expect(err.path).toBe("../../etc/passwd");
    expect(err.reason).toBe("Path escapes root");
    expect(err.message).toContain("../../etc/passwd");
    expect(err.message).toContain("Path escapes root");
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatter / formatFrontmatter
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  test("parses valid frontmatter with body", () => {
    const content = "---\nname: Test Topic\ndescription: A test topic\ntype: project\n---\nBody content here.";
    const result = parseFrontmatter(content);
    expect(result.frontmatter.name).toBe("Test Topic");
    expect(result.frontmatter.description).toBe("A test topic");
    expect(result.frontmatter.type).toBe("project");
    expect(result.body).toBe("Body content here.");
  });

  test("parses frontmatter with leading whitespace", () => {
    const content = "  \n---\nname: X\ndescription: Y\ntype: user\n---\nContent";
    const result = parseFrontmatter(content);
    expect(result.frontmatter.name).toBe("X");
    expect(result.body).toBe("Content");
  });

  test("parses frontmatter with empty body", () => {
    const content = "---\nname: X\ndescription: Y\ntype: feedback\n---\n";
    const result = parseFrontmatter(content);
    expect(result.frontmatter.name).toBe("X");
    expect(result.body).toBe("");
  });

  test("throws if no opening delimiter", () => {
    expect(() => parseFrontmatter("no frontmatter here")).toThrow(
      "does not start with frontmatter delimiter",
    );
  });

  test("throws if no closing delimiter", () => {
    expect(() =>
      parseFrontmatter("---\nname: X\ndescription: Y\ntype: user"),
    ).toThrow("No closing frontmatter delimiter found");
  });

  test("throws if frontmatter fails schema validation", () => {
    expect(() =>
      parseFrontmatter("---\nname: X\ntype: invalid_type\n---\nBody"),
    ).toThrow();
  });
});

describe("formatFrontmatter", () => {
  test("roundtrips with parseFrontmatter", () => {
    const fm: MemoryFrontmatter = {
      name: "My Topic",
      description: "Some description",
      type: "reference",
    };
    const body = "This is the body content.";
    const formatted = formatFrontmatter(fm, body);
    const parsed = parseFrontmatter(formatted);
    expect(parsed.frontmatter).toEqual(fm);
    expect(parsed.body).toBe(body);
  });

  test("formats with correct structure", () => {
    const fm: MemoryFrontmatter = {
      name: "Test",
      description: "Desc",
      type: "project",
    };
    const result = formatFrontmatter(fm, "body");
    expect(result.startsWith("---\n")).toBe(true);
    expect(result).toContain("---\n");
    expect(result).toContain("name: Test");
    expect(result).toContain("description: Desc");
    expect(result).toContain("type: project");
  });
});

// ---------------------------------------------------------------------------
// parseIndex / formatIndex
// ---------------------------------------------------------------------------

describe("parseIndex", () => {
  test("parses valid index entries", () => {
    const content = `- [React Patterns](react_patterns) — Common React patterns\n- [API Design](api_design) — REST API best practices\n`;
    const entries = parseIndex(content);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      title: "React Patterns",
      name: "react_patterns",
      summary: "Common React patterns",
    });
    expect(entries[1]).toEqual({
      title: "API Design",
      name: "api_design",
      summary: "REST API best practices",
    });
  });

  test("skips blank lines and comments", () => {
    const content = `# Memory Index\n\n- [Test](test_name) — Summary\n\n# Another comment\n`;
    const entries = parseIndex(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("Test");
  });

  test("returns empty array for empty content", () => {
    expect(parseIndex("")).toEqual([]);
    expect(parseIndex("# Just a heading\n")).toEqual([]);
  });

  test("handles entries with special characters in summary", () => {
    const content = "- [Title](test_name) — Summary with — dashes & stuff\n";
    const entries = parseIndex(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toBe("Summary with — dashes & stuff");
  });
});

describe("formatIndex", () => {
  test("roundtrips with parseIndex", () => {
    const entries: MemoryIndexEntry[] = [
      { title: "Topic A", name: "topic_a", summary: "Summary A" },
      { title: "Topic B", name: "topic_b", summary: "Summary B" },
    ];
    const formatted = formatIndex(entries);
    const parsed = parseIndex(formatted);
    expect(parsed).toEqual(entries);
  });

  test("formats single entry correctly", () => {
    const entries: MemoryIndexEntry[] = [
      { title: "Test", name: "test_topic", summary: "A test" },
    ];
    const result = formatIndex(entries);
    expect(result).toBe("- [Test](test_topic) — A test\n");
  });

  test("formats empty array as empty string with newline", () => {
    const result = formatIndex([]);
    expect(result).toBe("\n");
  });
});

// ---------------------------------------------------------------------------
// MemoryFileManager — path validation
// ---------------------------------------------------------------------------

describe("MemoryFileManager — path validation", () => {
  let manager: MemoryFileManager;

  beforeEach(() => {
    manager = makeManager();
  });

  test("resolveProjectPath resolves valid relative path", async () => {
    const result = await manager.resolveProjectPath("knowledge/topic.md");
    expect(result).toBe(resolve(join(TMP_DIR, "project", ".archcode", "memory", "knowledge", "topic.md")));
  });

  test("resolveUserPath resolves valid relative path", async () => {
    const result = await manager.resolveUserPath("preferences.md");
    expect(result).toBe(resolve(join(TMP_DIR, "user", ".archcode", "memory", "preferences.md")));
  });

  test("rejects path traversal with ..", async () => {
    expect(manager.resolveProjectPath("../../etc/passwd")).rejects.toThrow(MemoryPathError);
    await expect(manager.resolveProjectPath("../../etc/passwd")).rejects.toThrow("escapes");
  });

  test("rejects absolute paths", async () => {
    await expect(manager.resolveProjectPath("/etc/passwd")).rejects.toThrow(MemoryPathError);
    await expect(manager.resolveProjectPath("/etc/passwd")).rejects.toThrow("Absolute");
  });

  test("rejects path traversal on user root", async () => {
    await expect(manager.resolveUserPath("../../../etc/shadow")).rejects.toThrow(MemoryPathError);
  });

  test("rejects path that escapes root after normalization", async () => {
    await expect(manager.resolveProjectPath("knowledge/../../../etc/passwd")).rejects.toThrow(MemoryPathError);
  });

  test("isContained returns true for paths within root", () => {
    const root = "/home/user/.archcode/memory";
    expect(manager.isContained("/home/user/.archcode/memory/file.md", root)).toBe(true);
    expect(manager.isContained("/home/user/.archcode/memory/sub/file.md", root)).toBe(true);
  });

  test("isContained returns false for paths outside root", () => {
    const root = "/home/user/.archcode/memory";
    expect(manager.isContained("/etc/passwd", root)).toBe(false);
    expect(manager.isContained("/home/user/.archcode/other", root)).toBe(false);
  });

  test("isContained returns true for exact root match", () => {
    const root = "/home/user/.archcode/memory";
    expect(manager.isContained(root, root)).toBe(true);
  });

  test("rejects symlink pointing outside project root", async () => {
    const knowledgeDir = join(TMP_DIR, "project", ".archcode", "memory", "knowledge");
    await mkdir(knowledgeDir, { recursive: true });
    const outsideDir = join(TMP_DIR, "outside");
    await mkdir(outsideDir, { recursive: true });
    await Bun.write(join(outsideDir, "secret.md"), "secret content");
    const symlinkPath = join(knowledgeDir, "escape.md");
    const { symlink } = await import("node:fs/promises");
    await symlink(join(outsideDir, "secret.md"), symlinkPath);
    await expect(manager.resolveProjectPath("knowledge/escape.md")).rejects.toThrow(MemoryPathError);
  });

  test("allows symlink pointing within project root", async () => {
    const knowledgeDir = join(TMP_DIR, "project", ".archcode", "memory", "knowledge");
    await mkdir(knowledgeDir, { recursive: true });
    await Bun.write(join(knowledgeDir, "real.md"), "real content");
    const symlinkPath = join(knowledgeDir, "link.md");
    const { symlink } = await import("node:fs/promises");
    await symlink(join(knowledgeDir, "real.md"), symlinkPath);
    const result = await manager.resolveProjectPath("knowledge/link.md");
    expect(result).toContain("real.md");
  });
});

// ---------------------------------------------------------------------------
// MemoryFileManager — read methods
// ---------------------------------------------------------------------------

describe("MemoryFileManager — read methods", () => {
  let manager: MemoryFileManager;

  beforeEach(() => {
    manager = makeManager();
  });

  test("readIndex returns null when index.md does not exist", async () => {
    const result = await manager.readIndex();
    expect(result).toBeNull();
  });

  test("readIndex returns content when index.md exists", async () => {
    const indexPath = join(TMP_DIR, "project", ".archcode", "memory", "index.md");
    await Bun.write(indexPath, "- [Test](test_memory) — Summary\n");
    const result = await manager.readIndex();
    expect(result).toBe("- [Test](test_memory) — Summary\n");
  });

  test("readPreferences returns null when preferences.md does not exist", async () => {
    expect(await manager.readPreferences()).toBeNull();
  });

  test("readPreferences returns content for user preferences", async () => {
    const prefPath = join(TMP_DIR, "user", ".archcode", "memory", "preferences.md");
    await Bun.write(prefPath, "I prefer dark mode");
    const result = await manager.readPreferences();
    expect(result).toBe("I prefer dark mode");
  });

  test("readTopic returns null when topic does not exist", async () => {
    const result = await manager.readTopic("nonexistent");
    expect(result).toBeNull();
  });

  test("readTopic parses frontmatter and returns MemoryTopicFile", async () => {
    const knowledgeDir = join(TMP_DIR, "project", ".archcode", "memory", "knowledge");
    await mkdir(knowledgeDir, { recursive: true });
    const content = "---\nname: My Topic\ndescription: A description\ntype: project\n---\nTopic body content.";
    await Bun.write(join(knowledgeDir, "my_topic.md"), content);

    const result = await manager.readTopic("my_topic");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("My Topic");
    expect(result!.description).toBe("A description");
    expect(result!.type).toBe("project");
    expect(result!.content).toBe("Topic body content.");
  });

  test("listTopics returns empty array when knowledge dir does not exist", async () => {
    const result = await manager.listTopics();
    expect(result).toEqual([]);
  });

  test("listTopics returns sorted names (without .md) from knowledge dir", async () => {
    const knowledgeDir = join(TMP_DIR, "project", ".archcode", "memory", "knowledge");
    await mkdir(knowledgeDir, { recursive: true });
    await Bun.write(join(knowledgeDir, "beta.md"), "");
    await Bun.write(join(knowledgeDir, "alpha.md"), "");
    await Bun.write(join(knowledgeDir, "gamma.md"), "");
    await Bun.write(join(knowledgeDir, "notes.txt"), ""); // non-md file

    const result = await manager.listTopics();
    expect(result).toEqual(["alpha", "beta", "gamma"]);
  });
});

// ---------------------------------------------------------------------------
// MemoryFileManager — write methods (atomic)
// ---------------------------------------------------------------------------

describe("MemoryFileManager — write methods", () => {
  let manager: MemoryFileManager;

  beforeEach(() => {
    manager = makeManager();
  });

  test("writeTopic creates file with frontmatter", async () => {
    const fm: MemoryFrontmatter = {
      name: "New Topic",
      description: "A new topic",
      type: "reference",
    };
    await manager.writeTopic("new_topic", fm, "Topic content here.");

    const result = await manager.readTopic("new_topic");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("New Topic");
    expect(result!.description).toBe("A new topic");
    expect(result!.type).toBe("reference");
    expect(result!.content).toBe("Topic content here.");
  });

  test("writeTopic creates knowledge dir if missing", async () => {
    const fm: MemoryFrontmatter = {
      name: "Test",
      description: "Test desc",
      type: "user",
    };
    await manager.writeTopic("test", fm, "Content");

    const knowledgeDir = join(TMP_DIR, "project", ".archcode", "memory", "knowledge");
    const entries = await readdir(knowledgeDir);
    expect(entries).toContain("test.md");
  });

  test("writeTopic overwrites existing topic", async () => {
    const fm1: MemoryFrontmatter = {
      name: "Original",
      description: "Original desc",
      type: "project",
    };
    await manager.writeTopic("topic", fm1, "Original content");

    const fm2: MemoryFrontmatter = {
      name: "Updated",
      description: "Updated desc",
      type: "feedback",
    };
    await manager.writeTopic("topic", fm2, "Updated content");

    const result = await manager.readTopic("topic");
    expect(result!.name).toBe("Updated");
    expect(result!.content).toBe("Updated content");
  });

  test("writePreferences writes user preferences atomically", async () => {
    await manager.writePreferences("I prefer dark theme");
    const result = await manager.readPreferences();
    expect(result).toBe("I prefer dark theme");
  });

  test("writeIndex writes index.md atomically", async () => {
    const knowledgeDir = join(TMP_DIR, "project", ".archcode", "memory", "knowledge");
    await mkdir(knowledgeDir, { recursive: true });
    await Bun.write(join(knowledgeDir, "a.md"), "---\nname: Topic A\ndescription: Summary A\ntype: project\n---\nContent A");
    await Bun.write(join(knowledgeDir, "b.md"), "---\nname: Topic B\ndescription: Summary B\ntype: project\n---\nContent B");

    const entries: MemoryIndexEntry[] = [
      { title: "Topic A", name: "a", summary: "Summary A" },
      { title: "Topic B", name: "b", summary: "Summary B" },
    ];
    await manager.writeIndex(entries);

    const content = await manager.readIndex();
    expect(content).not.toBeNull();
    expect(content).toContain("Topic A");
    expect(content).toContain("Topic B");
  });

  test("writeIndex filters out entries with nonexistent names", async () => {
    const knowledgeDir = join(TMP_DIR, "project", ".archcode", "memory", "knowledge");
    await mkdir(knowledgeDir, { recursive: true });
    await Bun.write(join(knowledgeDir, "exists.md"), "---\nname: Exists\ndescription: Desc\ntype: project\n---\nContent");

    const entries: MemoryIndexEntry[] = [
      { title: "Exists", name: "exists", summary: "Desc" },
      { title: "Ghost", name: "ghost", summary: "Does not exist" },
    ];
    await manager.writeIndex(entries);

    const content = await manager.readIndex();
    expect(content).not.toBeNull();
    expect(content).toContain("Exists");
    expect(content).not.toContain("Ghost");
  });

  test("atomic write uses tmp+rename (no leftover temp files)", async () => {
    const fm: MemoryFrontmatter = {
      name: "Atomic Test",
      description: "Testing atomicity",
      type: "project",
    };
    await manager.writeTopic("atomic", fm, "Atomic content");

    const knowledgeDir = join(TMP_DIR, "project", ".archcode", "memory", "knowledge");
    const entries = await readdir(knowledgeDir);
    const tmpFiles = entries.filter((e) => e.startsWith(".tmp-"));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MemoryFileManager — rebuildIndex
// ---------------------------------------------------------------------------

describe("MemoryFileManager — rebuildIndex", () => {
  let manager: MemoryFileManager;

  beforeEach(() => {
    manager = makeManager();
  });

  test("rebuildIndex generates correct index from knowledge dir", async () => {
    const knowledgeDir = join(TMP_DIR, "project", ".archcode", "memory", "knowledge");
    await mkdir(knowledgeDir, { recursive: true });

    const topic1 = "---\nname: React Patterns\ndescription: Common React patterns\ntype: reference\n---\nContent 1";
    const topic2 = "---\nname: API Design\ndescription: REST API best practices\ntype: project\n---\nContent 2";
    await Bun.write(join(knowledgeDir, "react_patterns.md"), topic1);
    await Bun.write(join(knowledgeDir, "api_design.md"), topic2);

    await manager.rebuildIndex();

    const indexContent = await manager.readIndex();
    expect(indexContent).not.toBeNull();
    const entries = parseIndex(indexContent!);
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const titles = entries.map((e) => e.title);
    expect(titles).toContain("React Patterns");
    expect(titles).toContain("API Design");
  });

  test("rebuildIndex skips files with invalid frontmatter", async () => {
    const knowledgeDir = join(TMP_DIR, "project", ".archcode", "memory", "knowledge");
    await mkdir(knowledgeDir, { recursive: true });

    const validTopic = "---\nname: Valid\ndescription: Valid desc\ntype: project\n---\nValid content";
    const invalidTopic = "This has no frontmatter at all";
    await Bun.write(join(knowledgeDir, "valid.md"), validTopic);
    await Bun.write(join(knowledgeDir, "invalid.md"), invalidTopic);

    await manager.rebuildIndex();

    const indexContent = await manager.readIndex();
    expect(indexContent).not.toBeNull();
    const entries = parseIndex(indexContent!);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("Valid");
  });

  test("rebuildIndex handles empty knowledge dir", async () => {
    const knowledgeDir = join(TMP_DIR, "project", ".archcode", "memory", "knowledge");
    await mkdir(knowledgeDir, { recursive: true });

    await manager.rebuildIndex();

    const indexContent = await manager.readIndex();
    expect(indexContent).not.toBeNull();
    const entries = parseIndex(indexContent!);
    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MemoryFileManager — searchIndex
// ---------------------------------------------------------------------------

describe("MemoryFileManager — searchIndex", () => {
  let manager: MemoryFileManager;

  beforeEach(() => {
    manager = makeManager();
  });

  test("searchIndex matches title case-insensitively", () => {
    const entries: MemoryIndexEntry[] = [
      { title: "React Patterns", name: "react_patterns", summary: "Common patterns" },
      { title: "API Design", name: "api_design", summary: "REST best practices" },
    ];
    const results = manager.searchIndex("react", entries);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("React Patterns");
  });

  test("searchIndex matches summary case-insensitively", () => {
    const entries: MemoryIndexEntry[] = [
      { title: "React Patterns", name: "react_patterns", summary: "Common patterns" },
      { title: "API Design", name: "api_design", summary: "REST best practices" },
    ];
    const results = manager.searchIndex("best practices", entries);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("API Design");
  });

  test("searchIndex deduplicates by name", () => {
    const entries: MemoryIndexEntry[] = [
      { title: "React Patterns", name: "react_patterns", summary: "Common patterns" },
      { title: "React Patterns 2", name: "react_patterns", summary: "More patterns" },
    ];
    const results = manager.searchIndex("react", entries);
    expect(results).toHaveLength(1);
  });

  test("searchIndex returns max 20 results", () => {
    const entries: MemoryIndexEntry[] = Array.from({ length: 30 }, (_, i) => ({
      title: `Topic ${i}`,
      name: `topic_${i}`,
      summary: "matching query",
    }));
    const results = manager.searchIndex("query", entries);
    expect(results).toHaveLength(20);
  });

  test("searchIndex returns empty for no matches", () => {
    const entries: MemoryIndexEntry[] = [
      { title: "React Patterns", name: "react_patterns", summary: "Common patterns" },
    ];
    const results = manager.searchIndex("python", entries);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: full roundtrip
// ---------------------------------------------------------------------------

describe("MemoryFileManager — integration roundtrip", () => {
  let manager: MemoryFileManager;

  beforeEach(() => {
    manager = makeManager();
  });

  test("write topic → read topic → rebuild index → search", async () => {
    const fm1: MemoryFrontmatter = {
      name: "TypeScript Tips",
      description: "Useful TypeScript patterns",
      type: "reference",
    };
    const fm2: MemoryFrontmatter = {
      name: "Bun Runtime",
      description: "Bun-specific runtime tips",
      type: "project",
    };

    await manager.writeTopic("typescript_tips", fm1, "Use `satisfies` for type checking.");
    await manager.writeTopic("bun_runtime", fm2, "Use `Bun.file()` for file I/O.");

    // Read back
    const topic1 = await manager.readTopic("typescript_tips");
    expect(topic1!.name).toBe("TypeScript Tips");
    expect(topic1!.content).toBe("Use `satisfies` for type checking.");

    // Rebuild index
    await manager.rebuildIndex();
    const indexContent = await manager.readIndex();
    expect(indexContent).not.toBeNull();

    const entries = parseIndex(indexContent!);
    expect(entries.length).toBe(2);

    // Search
    const results = manager.searchIndex("typescript", entries);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("TypeScript Tips");

    // Write preferences
    await manager.writePreferences("I prefer functional style");
    const prefs = await manager.readPreferences();
    expect(prefs).toBe("I prefer functional style");
  });
});
