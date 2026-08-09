import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_MAX_PREFERENCES_BYTES,
  MAX_MEMORY_TOPIC_BYTES,
  MAX_MEMORY_TOPICS,
} from "./constants";
import {
  MemoryCapacityError,
  MemoryRevisionConflictError,
  MemoryValidationError,
} from "./errors";
import { formatFrontmatter, formatIndex, MemoryFileManager } from "./file-manager";
import { MemoryService, memoryRevision } from "./service";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "service", crypto.randomUUID());
const USER_ROOT = join(TMP_ROOT, "user");

function makeService(project = "project"): {
  files: MemoryFileManager;
  service: MemoryService;
} {
  const files = new MemoryFileManager({
    project: join(TMP_ROOT, project),
    user: USER_ROOT,
  });
  return { files, service: new MemoryService(files) };
}

function exactAsciiBytes(bytes: number): string {
  return `${"a ".repeat(Math.floor(bytes / 2))}${bytes % 2 === 0 ? "" : "a"}`;
}

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(USER_ROOT, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("MemoryService capacity and CAS", () => {
  test("accepts preferences at exactly 8 KiB and rejects one byte more", async () => {
    const { service } = makeService();
    const exact = await service.putPreferences({
      content: exactAsciiBytes(DEFAULT_MAX_PREFERENCES_BYTES),
      expectedRevision: null,
    });
    expect(exact.capacity.bytes).toBe(DEFAULT_MAX_PREFERENCES_BYTES);
    expect(exact.capacity.state).toBe("at-limit");

    await expect(service.putPreferences({
      content: exactAsciiBytes(DEFAULT_MAX_PREFERENCES_BYTES + 1),
      expectedRevision: exact.revision,
    })).rejects.toBeInstanceOf(MemoryCapacityError);
    expect((await service.readPreferences())?.revision).toBe(exact.revision);
  });

  test("counts topic frontmatter in the 16 KiB boundary", async () => {
    const { service } = makeService();
    const emptyDocument = formatFrontmatter({
      name: "boundary",
      description: "",
      type: "project",
    }, "");
    const exactBody = exactAsciiBytes(MAX_MEMORY_TOPIC_BYTES - Buffer.byteLength(emptyDocument));
    const exact = await service.putTopic({
      name: "boundary",
      description: "",
      type: "project",
      content: exactBody,
      expectedRevision: null,
    });
    expect(exact.capacity.bytes).toBe(MAX_MEMORY_TOPIC_BYTES);

    await expect(service.putTopic({
      name: "boundary",
      description: "",
      type: "project",
      content: `${exactBody}a`,
      expectedRevision: exact.revision,
    })).rejects.toBeInstanceOf(MemoryCapacityError);
  });

  test("uses exact raw-document revisions for optimistic concurrency", async () => {
    const { service } = makeService();
    const created = await service.putPreferences({ content: "first", expectedRevision: null });
    expect(created.revision).toBe(memoryRevision("first"));

    const updated = await service.putPreferences({
      content: "second",
      expectedRevision: created.revision,
    });
    await expect(service.putPreferences({
      content: "stale overwrite",
      expectedRevision: created.revision,
    })).rejects.toBeInstanceOf(MemoryRevisionConflictError);
    expect((await service.readPreferences())?.revision).toBe(updated.revision);
  });

  test("allows only non-increasing edits for a legacy oversized file", async () => {
    const { files, service } = makeService();
    const legacy = exactAsciiBytes(DEFAULT_MAX_PREFERENCES_BYTES + 100);
    await files.writePreferences(legacy);

    const legacySnapshot = await service.snapshot();
    expect(legacySnapshot.preferences?.availableForPrompt).toBe(false);
    expect(legacySnapshot.warnings).toContainEqual(expect.objectContaining({
      code: "preferences_over_capacity",
      target: "preferences",
    }));

    const unchanged = await service.putPreferences({
      content: legacy,
      expectedRevision: memoryRevision(legacy),
    });
    expect(unchanged.capacity.mutationPolicy).toBe("shrink-only");

    const smaller = legacy.slice(0, -1);
    const shrunk = await service.putPreferences({
      content: smaller,
      expectedRevision: unchanged.revision,
    });
    await expect(service.putPreferences({
      content: `${smaller}aa`,
      expectedRevision: shrunk.revision,
    })).rejects.toBeInstanceOf(MemoryCapacityError);
  });

  test("blocks a new 201st topic but permits updates at the limit", async () => {
    const { files, service } = makeService();
    for (let index = 0; index < MAX_MEMORY_TOPICS; index += 1) {
      await files.writeTopic(`topic_${index}`, {
        name: `topic_${index}`,
        description: "seed",
        type: "project",
      }, "body");
    }
    const first = await service.readTopic("topic_0");
    if (first === null) throw new Error("seed topic missing");
    await service.putTopic({
      name: "topic_0",
      description: "updated",
      type: "project",
      content: "new body",
      expectedRevision: first.revision,
    });
    await expect(service.putTopic({
      name: "topic_200",
      description: "overflow",
      type: "project",
      content: "body",
      expectedRevision: null,
    })).rejects.toBeInstanceOf(MemoryCapacityError);
    expect((await service.snapshot()).index.topicCount.count).toBe(MAX_MEMORY_TOPICS);
  });

  test("deletes over-capacity legacy files and rebuilds a consistent index", async () => {
    const { files, service } = makeService("legacy-over-cap");
    const legacyPreferences = exactAsciiBytes(25 * 1024);
    const emptyOversizedTopic = formatFrontmatter({
      name: "Oversized",
      description: "legacy topic",
      type: "project",
    }, "");
    const oversizedBody = exactAsciiBytes(20 * 1024 - Buffer.byteLength(emptyOversizedTopic));
    const oversizedDocument = formatFrontmatter({
      name: "Oversized",
      description: "legacy topic",
      type: "project",
    }, oversizedBody);

    await files.writePreferences(legacyPreferences);
    await files.writeTopicDocument("oversized", oversizedDocument);
    for (let index = 0; index < MAX_MEMORY_TOPICS; index += 1) {
      await files.writeTopic(`legacy_${index}`, {
        name: `Legacy ${index}`,
        description: "seed",
        type: "project",
      }, "body");
    }
    await files.rebuildIndex();

    const originalIndex = await files.readIndex();
    const snapshot = await service.snapshot();
    expect(snapshot.preferences?.content).toBe(legacyPreferences);
    expect(snapshot.preferences?.capacity.bytes).toBe(25 * 1024);
    expect((await service.readTopic("oversized"))?.capacity.bytes).toBe(20 * 1024);
    expect(snapshot.index.topicCount.count).toBe(MAX_MEMORY_TOPICS + 1);
    expect(snapshot.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "preferences_over_capacity",
      "topic_over_capacity",
      "topic_count_over_capacity",
    ]));
    const blockedManifest = await service.readPromptManifest();
    expect(blockedManifest.preferences?.availableForPrompt).toBe(false);
    expect(blockedManifest.index.availableForPrompt).toBe(false);
    expect(await files.readIndex()).toBe(originalIndex);

    // Deletion remains available while the corresponding legacy capacity
    // warning is active. Clearing preferences does not touch the project
    // count, so the count warning remains active as well.
    await service.deletePreferences({ expectedRevision: memoryRevision(legacyPreferences) });
    expect(await files.readPreferences()).toBeNull();
    expect((await service.snapshot()).warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "topic_over_capacity",
      "topic_count_over_capacity",
    ]));

    // Removing any topic is allowed while the project still has 201 topics;
    // the generated index must immediately drop that file and return to the
    // 200-topic limit.
    const removable = await service.readTopic("legacy_199");
    if (removable === null) throw new Error("legacy topic missing");
    await service.deleteTopic({ name: "legacy_199", expectedRevision: removable.revision });
    expect(await files.readTopicDocument("legacy_199")).toBeNull();

    const countRepaired = await service.snapshot();
    expect(countRepaired.index.topicCount.count).toBe(MAX_MEMORY_TOPICS);
    expect(countRepaired.index.topicCount.canCreate).toBe(false);
    expect(countRepaired.warnings.map((warning) => warning.code)).toEqual(["topic_over_capacity"]);

    // The oversized topic itself can then be removed without first shrinking
    // it. This exercises the explicit delete lane for an over-capacity file.
    const oversized = await service.readTopic("oversized");
    if (oversized === null) throw new Error("oversized topic missing");
    await service.deleteTopic({ name: "oversized", expectedRevision: oversized.revision });
    expect(await files.readTopicDocument("oversized")).toBeNull();

    const repairedManifest = await service.readPromptManifest();
    expect(repairedManifest.preferences).toBeNull();
    expect(repairedManifest.index.availableForPrompt).toBe(true);
    expect(repairedManifest.index.topicCount.count).toBe(MAX_MEMORY_TOPICS - 1);
    expect((await service.snapshot()).warnings).toEqual([]);

    const rebuiltIndex = await files.readIndex();
    expect(rebuiltIndex).not.toContain("(legacy_199)");
    expect(rebuiltIndex).not.toContain("(oversized)");
    expect(rebuiltIndex?.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(MAX_MEMORY_TOPICS - 1);

    const singleProject = makeService("single-oversized-topic");
    await singleProject.files.writeTopicDocument("oversized", oversizedDocument);
    await singleProject.files.rebuildIndex();
    expect((await singleProject.service.readPromptManifest()).index.availableForPrompt).toBe(true);
  });
});

describe("MemoryService mutation lanes", () => {
  test("rejects injected topic metadata before changing the topic or index", async () => {
    const { files, service } = makeService();
    const original = await service.putTopic({
      name: "safe_topic",
      title: "Safe",
      description: "Original description",
      type: "project",
      content: "original body",
      expectedRevision: null,
    });
    const originalDocument = await files.readTopicDocument("safe_topic");
    const originalIndex = await files.readIndex();

    await expect(service.putTopic({
      name: "safe_topic",
      title: "Safe\nextra: injected",
      description: "Replacement description",
      type: "project",
      content: "replacement body",
      expectedRevision: original.revision,
    })).rejects.toBeInstanceOf(MemoryValidationError);

    expect(await files.readTopicDocument("safe_topic")).toBe(originalDocument);
    expect(await files.readIndex()).toBe(originalIndex);

    await expect(service.writeExplicit({
      name: "safe_topic",
      description: "Safe\ntype: feedback",
      type: "reference",
      content: "explicit replacement",
      scope: "project",
    })).rejects.toBeInstanceOf(MemoryValidationError);

    expect(await files.readTopicDocument("safe_topic")).toBe(originalDocument);
    expect(await files.readIndex()).toBe(originalIndex);
  });

  test("explicit topic updates preserve omitted metadata on an existing topic", async () => {
    const { service } = makeService();
    await service.putTopic({
      name: "build_tools",
      title: "Build Tooling",
      description: "Pinned project tooling",
      type: "reference",
      content: "old body",
      expectedRevision: null,
    });

    await service.writeExplicit({
      name: "build_tools",
      content: "new body",
      scope: "project",
    });

    expect(await service.readTopic("build_tools")).toMatchObject({
      title: "Build Tooling",
      description: "Pinned project tooling",
      type: "reference",
      content: "new body",
    });
  });

  test("serializes explicit preference appends across projects sharing one user root", async () => {
    const first = makeService("project-a").service;
    const second = makeService("project-b").service;
    await Promise.all([
      first.writeExplicit({ name: "preferences", scope: "user", content: "alpha" }),
      second.writeExplicit({ name: "preferences", scope: "user", content: "beta" }),
    ]);

    const content = (await first.readPreferences())?.content ?? "";
    expect(content).toContain("alpha");
    expect(content).toContain("beta");
    expect(content.match(/---/g)).toHaveLength(1);
  });

  test("keeps topic deletion and generated index rebuild in one project lane", async () => {
    const { service } = makeService();
    const first = await service.putTopic({
      name: "first",
      description: "first topic",
      type: "project",
      content: "body",
      expectedRevision: null,
    });
    await service.putTopic({
      name: "second",
      description: "second topic",
      type: "project",
      content: "body",
      expectedRevision: null,
    });

    await service.deleteTopic({ name: "first", expectedRevision: first.revision });
    expect(await service.readTopic("first")).toBeNull();
    const index = await service.readIndex();
    expect(index).not.toContain("(first)");
    expect(index).toContain("(second)");
  });

  test("replays final documents idempotently and preflights conflicts before writing", async () => {
    const { service } = makeService();
    const preferences = await service.putPreferences({ content: "old preference", expectedRevision: null });
    const topic = await service.putTopic({
      name: "build_tools",
      description: "Build tools",
      type: "project",
      content: "old topic",
      expectedRevision: null,
    });
    const finalPreferences = "new preference";
    const finalTopic = formatFrontmatter({
      name: "build_tools",
      description: "Build tools",
      type: "project",
    }, "new topic");
    expect(await service.readDocuments([
      { scope: "user", name: "preferences" },
      { scope: "project", name: "build_tools" },
    ])).toEqual([
      {
        scope: "project",
        name: "build_tools",
        document: formatFrontmatter({
          name: "build_tools",
          description: "Build tools",
          type: "project",
        }, "old topic"),
        revision: topic.revision,
      },
      {
        scope: "user",
        name: "preferences",
        document: "old preference",
        revision: preferences.revision,
      },
    ]);
    const targets = [
      {
        scope: "user" as const,
        name: "preferences",
        expectedRevision: preferences.revision,
        finalRevision: memoryRevision(finalPreferences),
        finalDocument: finalPreferences,
      },
      {
        scope: "project" as const,
        name: "build_tools",
        expectedRevision: topic.revision,
        finalRevision: memoryRevision(finalTopic),
        finalDocument: finalTopic,
      },
    ];
    const currentIndex = await service.readIndex();
    const indexReceipt = {
      expectedRevision: currentIndex === null ? null : memoryRevision(currentIndex),
      finalRevision: memoryRevision(currentIndex ?? ""),
      finalDocument: currentIndex ?? "",
    };

    expect(await service.applyFinalDocuments(targets, indexReceipt)).toMatchObject({ applied: 2, alreadyApplied: 0 });
    expect(await service.applyFinalDocuments(targets, indexReceipt)).toMatchObject({ applied: 0, alreadyApplied: 2 });

    const beforeConflict = await service.readPreferences();
    const conflictingTopicDocument = formatFrontmatter({
      name: "build_tools",
      description: "Build tools",
      type: "project",
    }, "conflicting topic");
    const conflictingTopic = {
      ...targets[1],
      expectedRevision: "stale",
      finalDocument: conflictingTopicDocument,
      finalRevision: memoryRevision(conflictingTopicDocument),
    };
    await expect(service.applyFinalDocuments([
      {
        ...targets[0],
        expectedRevision: beforeConflict?.revision ?? null,
        finalDocument: "should not write",
        finalRevision: memoryRevision("should not write"),
      },
      conflictingTopic,
    ], indexReceipt)).rejects.toBeInstanceOf(MemoryRevisionConflictError);
    expect((await service.readPreferences())?.revision).toBe(beforeConflict?.revision);
  });

  test("applies an automatic topic receipt without reading untouched topic bodies", async () => {
    const { files, service } = makeService("narrow-receipt-index");
    const selected = await service.putTopic({
      name: "selected",
      title: "Selected",
      description: "Original selected summary",
      type: "project",
      content: "old selected body",
      expectedRevision: null,
    });
    await service.putTopic({
      name: "untouched",
      title: "Untouched",
      description: "Untouched summary",
      type: "reference",
      content: "untouched body sentinel",
      expectedRevision: null,
    });
    const untouchedDocument = await files.readTopicDocument("untouched");
    const currentIndex = await files.readIndex();
    if (currentIndex === null) throw new Error("index missing");
    const finalTopic = formatFrontmatter({
      name: "Selected",
      description: "Updated selected summary",
      type: "project",
    }, "new selected body");
    const finalIndex = formatIndex([
      { title: "Selected", name: "selected", summary: "Updated selected summary" },
      { title: "Untouched", name: "untouched", summary: "Untouched summary" },
    ]);
    const readTopicDocument = files.readTopicDocument.bind(files);
    const rebuildIndex = files.rebuildIndex.bind(files);
    files.readTopicDocument = async (name: string) => {
      if (name === "untouched") {
        throw new Error("automatic receipt must not read untouched topic bodies");
      }
      return await readTopicDocument(name);
    };
    files.rebuildIndex = async () => {
      throw new Error("automatic receipt must not rebuild the index from topic bodies");
    };

    try {
      await service.applyFinalDocuments([{
        scope: "project",
        name: "selected",
        expectedRevision: selected.revision,
        finalDocument: finalTopic,
        finalRevision: memoryRevision(finalTopic),
      }], {
        expectedRevision: memoryRevision(currentIndex),
        finalDocument: finalIndex,
        finalRevision: memoryRevision(finalIndex),
      });
    } finally {
      files.readTopicDocument = readTopicDocument;
      files.rebuildIndex = rebuildIndex;
    }

    expect((await service.readTopic("selected"))?.content).toBe("new selected body");
    expect(await files.readTopicDocument("untouched")).toBe(untouchedDocument);
    expect(await files.readIndex()).toBe(finalIndex);
  });

  test("replays deterministically after the first target was written before an I/O failure", async () => {
    const { files, service } = makeService("partial-receipt");
    const preferences = await service.putPreferences({ content: "old preference", expectedRevision: null });
    const topic = await service.putTopic({
      name: "build_tools",
      description: "Build tools",
      type: "project",
      content: "old topic",
      expectedRevision: null,
    });
    const finalPreferences = "new preference";
    const finalTopic = formatFrontmatter({
      name: "build_tools",
      description: "Build tools",
      type: "project",
    }, "new topic");
    const indexDocument = await service.readIndex();
    if (indexDocument === null) throw new Error("index missing");
    const targets = [{
      scope: "project" as const,
      name: "build_tools",
      expectedRevision: topic.revision,
      finalDocument: finalTopic,
      finalRevision: memoryRevision(finalTopic),
    }, {
      scope: "user" as const,
      name: "preferences",
      expectedRevision: preferences.revision,
      finalDocument: finalPreferences,
      finalRevision: memoryRevision(finalPreferences),
    }];
    const indexReceipt = {
      expectedRevision: memoryRevision(indexDocument),
      finalDocument: indexDocument,
      finalRevision: memoryRevision(indexDocument),
    };
    const writePreferences = files.writePreferences.bind(files);
    let failOnce = true;
    files.writePreferences = async (document: string) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated crash after first target");
      }
      await writePreferences(document);
    };

    await expect(service.applyFinalDocuments(targets, indexReceipt)).rejects.toThrow("simulated crash");
    expect((await service.readTopic("build_tools"))?.content).toBe("new topic");
    expect((await service.readPreferences())?.content).toBe("old preference");

    expect(await service.applyFinalDocuments(targets, indexReceipt)).toMatchObject({
      applied: 1,
      alreadyApplied: 1,
    });
    expect((await service.readPreferences())?.content).toBe(finalPreferences);
    expect((await service.readTopic("build_tools"))?.content).toBe("new topic");
    expect(await service.readIndex()).toBe(indexDocument);
  });
});
