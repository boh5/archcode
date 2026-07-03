import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  GoalMemoryManager,
  GoalMemoryNameError,
  GoalMemoryPathError,
} from "./goal-memory";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "goal-memory");
const GOAL_A_ID = "550e8400-e29b-41d4-a716-446655440000";
const GOAL_B_ID = "550e8400-e29b-41d4-a716-446655440001";

async function captureAsyncError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected async action to throw");
}

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("GoalMemoryManager", () => {
  test("writes, reads, lists, and indexes topics under the owning goal memory root", async () => {
    const manager = new GoalMemoryManager(TMP_DIR);

    await manager.writeTopic(
      GOAL_A_ID,
      "handoff_notes",
      { name: "Handoff Notes", description: "Build handoff", type: "project" },
      "Use the goal-local cache.",
    );

    const topic = await manager.readTopic(GOAL_A_ID, "handoff_notes");
    expect(topic).toMatchObject({
      name: "Handoff Notes",
      description: "Build handoff",
      type: "project",
      content: "Use the goal-local cache.\n",
    });
    expect(topic?.filePath).toBe(join(TMP_DIR, ".archcode", "goals", GOAL_A_ID, "memory", "knowledge", "handoff_notes.md"));
    expect(await manager.listTopics(GOAL_A_ID)).toEqual(["handoff_notes"]);
    expect(await manager.readIndex(GOAL_A_ID)).toBe("- [Handoff Notes](handoff_notes) — Build handoff\n");
  });

  test("keeps Goal A memory invisible to Goal B", async () => {
    const manager = new GoalMemoryManager(TMP_DIR);

    await manager.writeTopic(
      GOAL_A_ID,
      "goal_a_context",
      { name: "Goal A Context", description: "Only A", type: "project" },
      "A-only context",
    );
    await manager.writeTopic(
      GOAL_B_ID,
      "goal_b_context",
      { name: "Goal B Context", description: "Only B", type: "project" },
      "B-only context",
    );

    expect(await manager.readTopic(GOAL_A_ID, "goal_b_context")).toBeNull();
    expect(await manager.readTopic(GOAL_B_ID, "goal_a_context")).toBeNull();
    expect(await manager.readIndex(GOAL_A_ID)).toContain("Goal A Context");
    expect(await manager.readIndex(GOAL_A_ID)).not.toContain("Goal B Context");
    expect(await manager.readIndex(GOAL_B_ID)).toContain("Goal B Context");
    expect(await manager.readIndex(GOAL_B_ID)).not.toContain("Goal A Context");
  });

  test("goal memory writes never mutate project memory", async () => {
    const manager = new GoalMemoryManager(TMP_DIR);
    const projectMemoryRoot = join(TMP_DIR, ".archcode", "memory");
    const projectIndexPath = join(projectMemoryRoot, "index.md");
    const projectTopicPath = join(projectMemoryRoot, "knowledge", "project_topic.md");
    await mkdir(join(projectMemoryRoot, "knowledge"), { recursive: true });
    await Bun.write(projectIndexPath, "- [Project Topic](project_topic) — Project only\n");
    await Bun.write(projectTopicPath, "project memory stays put\n");

    await manager.writeTopic(
      GOAL_A_ID,
      "goal_topic",
      { name: "Goal Topic", description: "Goal only", type: "project" },
      "goal memory",
    );

    expect(await Bun.file(projectIndexPath).text()).toBe("- [Project Topic](project_topic) — Project only\n");
    expect(await Bun.file(projectTopicPath).text()).toBe("project memory stays put\n");
    expect(existsSync(join(projectMemoryRoot, "knowledge", "goal_topic.md"))).toBe(false);
    expect(await Bun.file(join(TMP_DIR, ".archcode", "goals", GOAL_A_ID, "memory", "knowledge", "goal_topic.md")).exists()).toBe(true);
  });

  test("rejects traversal, reserved names, invalid names, and non-UUID goal ids", async () => {
    const manager = new GoalMemoryManager(TMP_DIR);
    const invalidNames = ["../project", "nested/topic", "has-dash", "index", "preferences"];

    for (const name of invalidNames) {
      const error = await captureAsyncError(() => {
        return manager.writeTopic(
          GOAL_A_ID,
          name,
          { name, description: "invalid", type: "project" },
          "invalid",
        );
      });
      expect(error).toBeInstanceOf(GoalMemoryNameError);
    }

    const goalIdError = await captureAsyncError(() => manager.readIndex("../goal-b"));
    expect(goalIdError).toBeInstanceOf(GoalMemoryPathError);
    expect(existsSync(join(TMP_DIR, ".archcode", "goals", GOAL_A_ID, "memory", "preferences.md"))).toBe(false);
    expect(existsSync(join(TMP_DIR, ".archcode", "goals", GOAL_A_ID, "memory", "knowledge", "index.md"))).toBe(false);
  });

  test("replaces current topics atomically without versions or temp files", async () => {
    const manager = new GoalMemoryManager(TMP_DIR);

    await manager.writeTopic(GOAL_A_ID, "current", { name: "Current", description: "First", type: "project" }, "first");
    await manager.writeTopic(GOAL_A_ID, "current", { name: "Current", description: "Second", type: "project" }, "second");

    const memoryRoot = join(TMP_DIR, ".archcode", "goals", GOAL_A_ID, "memory");
    const knowledgeDir = join(memoryRoot, "knowledge");
    expect(await manager.readIndex(GOAL_A_ID)).toBe("- [Current](current) — Second\n");
    expect((await manager.readTopic(GOAL_A_ID, "current"))?.content).toBe("second\n");
    expect((await readdir(knowledgeDir)).sort()).toEqual(["current.md"]);
    expect((await readdir(memoryRoot)).some((entry) => entry.startsWith(".tmp-"))).toBe(false);
    expect(existsSync(join(memoryRoot, "versions"))).toBe(false);
    expect(existsSync(join(memoryRoot, "revisions"))).toBe(false);
  });

  test("returns null and empty list for missing goal memory", async () => {
    const manager = new GoalMemoryManager(TMP_DIR);

    expect(await manager.readIndex(GOAL_A_ID)).toBeNull();
    expect(await manager.readTopic(GOAL_A_ID, "missing_topic")).toBeNull();
    expect(await manager.listTopics(GOAL_A_ID)).toEqual([]);
  });
});
