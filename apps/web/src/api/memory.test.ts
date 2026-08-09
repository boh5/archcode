import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  deleteMemoryTopic,
  getMemorySnapshot,
  putMemoryPreferences,
  putMemoryTopic,
} from "./memory";

const snapshot = {
  preferences: { content: "# Preferences\n", revision: "p1", capacity: { bytes: 14, maxBytes: 8192, state: "within-limit", mutationPolicy: "normal" }, availableForPrompt: true },
  topics: [],
  index: { revision: "i1", bytes: 20, topicCount: { count: 0, max: 200, state: "within-limit", canCreate: true }, availableForPrompt: true },
  warnings: [],
} as const;

describe("memory API", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
  });

  test("keeps project Memory requests scoped and encodes topic names", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/projects/demo%2Fproject/memory");
      return Response.json(snapshot);
    });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });

    await expect(getMemorySnapshot("demo/project")).resolves.toEqual(snapshot);
  });

  test("sends revisions with preferences and topic writes", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return Response.json({ ...snapshot.preferences, content: "updated", revision: "p2" });
    });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });

    await putMemoryPreferences({ slug: "demo", content: "updated", expectedRevision: "p1" });
    await putMemoryTopic({ slug: "demo", name: "build tools", title: "Build Tools", description: "Commands", type: "project", content: "body", expectedRevision: null });

    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ content: "updated", expectedRevision: "p1" });
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ content: "body", expectedRevision: null, title: "Build Tools", description: "Commands", type: "project" });
    expect(requests[1]?.url).toBe("/api/projects/demo/memory/topics/build%20tools");
  });

  test("preserves server revision conflicts", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: mock(async () => Response.json({ error: { code: "MEMORY_REVISION_CONFLICT", message: "Memory changed" } }, { status: 409 })),
    });

    await expect(deleteMemoryTopic({ slug: "demo", name: "build-tools", expectedRevision: "stale" })).rejects.toMatchObject({ code: "MEMORY_REVISION_CONFLICT", status: 409 });
  });
});
