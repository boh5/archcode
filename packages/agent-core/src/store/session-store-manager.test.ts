import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats } from "@specra/protocol";
import { SessionStoreManager } from "./session-store-manager";
import { sessionFileInternals } from "./helpers";
import { silentLogger } from "../logger";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "session-store-manager");

beforeEach(async () => {
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("SessionStoreManager", () => {
  function sessionId(): string {
    return crypto.randomUUID();
  }

  test("create() returns the same store for the same sessionId+workspaceRoot", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store1 = manager.create(id, TMP_DIR);
    const store2 = manager.create(id, TMP_DIR);
    expect(store1).toBe(store2);
  });

  test("create() returns different stores for different sessionIds", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const store1 = manager.create(sessionId(), TMP_DIR);
    const store2 = manager.create(sessionId(), TMP_DIR);
    expect(store1).not.toBe(store2);
  });

  test("get() returns undefined for unknown session", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    expect(manager.get(sessionId(), TMP_DIR)).toBeUndefined();
  });

  test("get() returns existing store after create()", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR);
    expect(manager.get(id, TMP_DIR)).toBe(store);
  });

  test("has() returns correct boolean", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    expect(manager.has(id, TMP_DIR)).toBe(false);
    manager.create(id, TMP_DIR);
    expect(manager.has(id, TMP_DIR)).toBe(true);
  });

  test("delete() removes store from registry", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    manager.create(id, TMP_DIR);
    expect(manager.has(id, TMP_DIR)).toBe(true);
    const result = manager.delete(id, TMP_DIR);
    expect(result).toBe(true);
    expect(manager.has(id, TMP_DIR)).toBe(false);
  });

  test("delete() returns false for unknown session", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    expect(manager.delete(sessionId(), TMP_DIR)).toBe(false);
  });

  test("clearAll() removes all stores from registry", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const idA = sessionId();
    const idB = sessionId();
    manager.create(idA, TMP_DIR);
    manager.create(idB, TMP_DIR);
    manager.clearAll();
    expect(manager.has(idA, TMP_DIR)).toBe(false);
    expect(manager.has(idB, TMP_DIR)).toBe(false);
  });

  test("getOrLoad() returns existing store from registry without disk I/O", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const created = manager.create(id, TMP_DIR);
    created.getState().title = "in-memory-title";

    const loaded = await manager.getOrLoad(id, TMP_DIR);
    expect(loaded).toBe(created);
    expect(loaded.getState().title).toBe("in-memory-title");
  });

  test("getOrLoad() loads from disk when not in registry", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();

    await sessionFileInternals.saveSessionTranscript(
      {
        sessionId,
        createdAt: 1000,
        title: "disk-title",
        messages: [],
        steps: [],
        stats: createEmptySessionStats(),
        runs: [],
        todos: [],
        rootSessionId: sessionId,
      },
      TMP_DIR,
    );

    const store = await manager.getOrLoad(sessionId, TMP_DIR);
    expect(store.getState().sessionId).toBe(sessionId);
    expect(store.getState().title).toBe("disk-title");
  });

  test("getSessionFile() finds a child session through lazy descendant scan", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    const childSessionId = sessionId();

    await sessionFileInternals.saveSessionTranscript(
      {
        sessionId: childSessionId,
        createdAt: 1000,
        title: "child-title",
        messages: [],
        steps: [],
        stats: createEmptySessionStats(),
        runs: [],
        todos: [],
        rootSessionId,
        parentSessionId: rootSessionId,
      },
      TMP_DIR,
    );

    const file = await manager.getSessionFile(TMP_DIR, childSessionId);

    expect(file.sessionId).toBe(childSessionId);
    expect(file.rootSessionId).toBe(rootSessionId);
    expect(file.title).toBe("child-title");
  });

  test("getSessionFile() reuses the lazy index after the first scan", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    const childSessionId = sessionId();
    const originalScanDescendants = sessionFileInternals.scanDescendants;
    let scanCount = 0;

    await sessionFileInternals.saveSessionTranscript(
      {
        sessionId: childSessionId,
        createdAt: 1000,
        title: "child-title",
        messages: [],
        steps: [],
        stats: createEmptySessionStats(),
        runs: [],
        todos: [],
        rootSessionId,
        parentSessionId: rootSessionId,
      },
      TMP_DIR,
    );

    sessionFileInternals.scanDescendants = async (...args) => {
      scanCount += 1;
      return await originalScanDescendants(...args);
    };

    try {
      await manager.getSessionFile(TMP_DIR, childSessionId);
      await manager.getSessionFile(TMP_DIR, childSessionId);
    } finally {
      sessionFileInternals.scanDescendants = originalScanDescendants;
    }

    expect(scanCount).toBe(1);
  });

  test("getOrLoad() does NOT overwrite an existing store (Bug 1 regression)", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();

    // Create store with in-memory state
    const created = manager.create(sessionId, TMP_DIR);
    created.setState({ title: "in-memory-title" });

    // Also save a file with different data
    await sessionFileInternals.saveSessionTranscript(
      {
        sessionId,
        createdAt: 1000,
        title: "disk-title",
        messages: [],
        steps: [],
        stats: createEmptySessionStats(),
        runs: [],
        todos: [],
        rootSessionId: sessionId,
      },
      TMP_DIR,
    );

    // getOrLoad should return the existing in-memory store, not overwrite
    const loaded = await manager.getOrLoad(sessionId, TMP_DIR);
    expect(loaded).toBe(created);
    expect(loaded.getState().title).toBe("in-memory-title");
  });

  test("getOrLoad() throws on missing file", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    await expect(manager.getOrLoad(sessionId(), TMP_DIR)).rejects.toThrow();
  });

  test("getOrLoad() throws on invalid JSON", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    const filePath = join(TMP_DIR, `${sessionId}.json`);
    await Bun.write(filePath, "not json");
    await expect(manager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("getOrLoad() deduplicates concurrent loads for the same session", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();

    await sessionFileInternals.saveSessionTranscript(
      {
        sessionId,
        createdAt: 1000,
        title: "disk-title",
        messages: [],
        steps: [],
        stats: createEmptySessionStats(),
        runs: [],
        todos: [],
        rootSessionId: sessionId,
      },
      TMP_DIR,
    );

    const [store1, store2] = await Promise.all([
      manager.getOrLoad(sessionId, TMP_DIR),
      manager.getOrLoad(sessionId, TMP_DIR),
    ]);

    expect(store1).toBe(store2);
  });

  test("getOrLoad() does not overwrite store created during I/O window", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();

    await sessionFileInternals.saveSessionTranscript(
      {
        sessionId,
        createdAt: 1000,
        title: "disk-title",
        messages: [],
        steps: [],
        stats: createEmptySessionStats(),
        runs: [],
        todos: [],
        rootSessionId: sessionId,
      },
      TMP_DIR,
    );

    // Simulate a concurrent create() that happens while getOrLoad is reading from disk.
    // Start getOrLoad, but also create a store with live state before getOrLoad resolves.
    // The getOrLoad should return the live store, not overwrite it with disk data.
    const loadedPromise = manager.getOrLoad(sessionId, TMP_DIR);

    // Create a store with live state (simulating an agent starting up concurrently)
    const liveStore = manager.create(sessionId, TMP_DIR);
    liveStore.setState({ title: "live-title" });

    const loaded = await loadedPromise;
    // If getOrLoad saw the live store after I/O re-check, it returns it without overwriting.
    // If it missed it, it would have called create() which returns the existing live store
    // anyway (idempotent), then setState would overwrite with disk data.
    // Both paths should return the live store since create() is idempotent and the
    // re-check in #loadFromDisk prevents overwriting.
    expect(loaded).toBe(liveStore);
    expect(loaded.getState().title).toBe("live-title");
  });
});
