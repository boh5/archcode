import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolOutputArtifactStore } from "./artifact-store";
import { createTestArtifact } from "./artifact-store-fixture.test";
import type {
  ArtifactOwner,
  ArtifactSearchRunner,
  OutputRef,
} from "./artifact-types";

const TEST_ROOT = join(tmpdir(), "archcode-tool-output-tests", crypto.randomUUID());
const CURSOR_KEY = new Uint8Array(32).fill(7);

function identity(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

const OWNER: ArtifactOwner = {
  projectIdentity: identity("project-a"),
  rootSessionId: "root-a",
  producerSessionId: "child-a",
};

function makeStore(
  directory: string,
  overrides: Partial<ConstructorParameters<typeof ToolOutputArtifactStore>[0]> = {},
): ToolOutputArtifactStore {
  const { limits, ...rest } = overrides;
  return new ToolOutputArtifactStore({
    ...rest,
    rootDir: overrides.rootDir ?? directory,
    cursorKey: CURSOR_KEY,
    limits: {
      artifactMaxBytes: 64,
      artifactHeadMaxBytes: 40,
      artifactTailMaxBytes: 24,
      bodyQuotaBytes: 64 * 1024,
      bodyMaxActive: 100,
      bodyTtlMs: 1_000,
      tombstoneTtlMs: 1_000,
      cleanupIntervalMs: 1_000_000,
      staleTempMs: 100,
      readMaxBytes: 7,
      readMaxRecords: 1_000,
      ...limits,
    },
  });
}

async function readAll(
  store: ToolOutputArtifactStore,
  outputRef: OutputRef,
  scope: Pick<ArtifactOwner, "projectIdentity" | "rootSessionId"> = OWNER,
): Promise<string> {
  let cursor: string | undefined;
  let text = "";
  const seen = new Set<string>();
  do {
    const page = await store.read({
      projectIdentity: scope.projectIdentity,
      rootSessionId: scope.rootSessionId,
      outputRef,
      cursor,
    });
    text += page.records.map((record) => record.text).join("");
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      expect(seen.has(cursor)).toBe(false);
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  return text;
}

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("ToolOutputArtifactStore", () => {
  test("commits strict metadata and reads complete UTF-8 content without gaps", async () => {
    const store = makeStore(join(TEST_ROOT, "complete"));
    const content = "HEAD😀\nsecond line\nTAIL";
    const created = await createTestArtifact(store, { owner: OWNER, canonical: content });
    expect(created.outputRef).toHaveLength(22);
    expect(created.metadata.completeness).toBe("complete");
    expect(created.metadata.omitted.bytes).toBe(0);
    expect(await readAll(store, created.outputRef)).toBe(content);
    await store.dispose();
  });

  test("retains UTF-8-safe head and tail segments and reports an explicit gap", async () => {
    const store = makeStore(join(TEST_ROOT, "partial"));
    const content = `HEAD_SENTINEL:${"x".repeat(100)}:TAIL_SENTINEL😀`;
    const created = await createTestArtifact(store, { owner: OWNER, canonical: content });
    expect(created.metadata.completeness).toBe("partial");
    expect(created.metadata.stored.bytes).toBeLessThanOrEqual(64);
    expect(created.metadata.omitted.bytes).toBe(
      created.metadata.canonical.bytes - created.metadata.stored.bytes,
    );

    const first = await store.read({
      projectIdentity: OWNER.projectIdentity,
      rootSessionId: OWNER.rootSessionId,
      outputRef: created.outputRef,
    });
    expect(first.gap).toBeDefined();
    const retained = await readAll(store, created.outputRef);
    expect(retained).toContain("HEAD_SENTINEL");
    expect(retained).toContain("TAIL_SENTINEL😀");
    expect(retained).not.toContain("�");
    await store.dispose();
  });

  test("authorizes by project identity and root Session family", async () => {
    const store = makeStore(join(TEST_ROOT, "auth"));
    const created = await createTestArtifact(store, { owner: OWNER, canonical: "private" });
    await expect(
      store.read({
        projectIdentity: identity("project-b"),
        rootSessionId: OWNER.rootSessionId,
        outputRef: created.outputRef,
      }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_FORBIDDEN" });
    await expect(
      store.read({
        projectIdentity: OWNER.projectIdentity,
        rootSessionId: "other-root",
        outputRef: created.outputRef,
      }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_FORBIDDEN" });
    await store.dispose();
  });

  test("reloads committed artifacts after a store restart", async () => {
    const directory = join(TEST_ROOT, "restart");
    const firstStore = makeStore(directory);
    const created = await createTestArtifact(firstStore, { owner: OWNER, canonical: "restart-safe" });
    await firstStore.dispose();

    const secondStore = makeStore(directory);
    expect(await readAll(secondStore, created.outputRef)).toBe("restart-safe");
    await secondStore.dispose();
  });

  test("persists the cursor key so bounded reads can continue after restart", async () => {
    const directory = join(TEST_ROOT, "cursor-restart");
    const firstStore = new ToolOutputArtifactStore({
      rootDir: directory,
      limits: { readMaxBytes: 7 },
    });
    const created = await createTestArtifact(firstStore, {
      owner: OWNER,
      canonical: "first line\nsecond line\nthird line",
    });
    const firstPage = await firstStore.read({ ...OWNER, outputRef: created.outputRef, limit: 1 });
    expect(firstPage.nextCursor).toBeDefined();
    await firstStore.dispose();

    const secondStore = new ToolOutputArtifactStore({
      rootDir: directory,
      limits: { readMaxBytes: 7 },
    });
    const secondPage = await secondStore.read({
      ...OWNER,
      outputRef: created.outputRef,
      cursor: firstPage.nextCursor,
      limit: 1,
    });
    expect(secondPage.records[0]?.canonicalStart).toBeGreaterThan(0);
    await secondStore.dispose();
  });

  test("preserves an expired tombstone across restart until its own TTL expires", async () => {
    let now = 1_000;
    const directory = join(TEST_ROOT, "ttl");
    const store = makeStore(directory, {
      rootDir: directory,
      cursorKey: CURSOR_KEY,
      now: () => now,
      limits: { bodyTtlMs: 100, tombstoneTtlMs: 100 },
    });
    const created = await createTestArtifact(store, { owner: OWNER, canonical: "expires" });
    now = 1_101;
    await expect(
      store.read({ ...OWNER, outputRef: created.outputRef }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_EXPIRED" });
    await store.dispose();

    const restarted = makeStore(directory, {
      rootDir: directory,
      cursorKey: CURSOR_KEY,
      now: () => now,
      limits: { bodyTtlMs: 100, tombstoneTtlMs: 100 },
    });
    await expect(
      restarted.read({ ...OWNER, outputRef: created.outputRef }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_EXPIRED" });
    now = 1_202;
    await restarted.cleanup();
    await expect(
      restarted.read({ ...OWNER, outputRef: created.outputRef }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_NOT_FOUND" });
    await restarted.dispose();
  });

  test("preserves an evicted tombstone across restart", async () => {
    let now = 10;
    const directory = join(TEST_ROOT, "lru");
    const store = makeStore(directory, {
      rootDir: directory,
      cursorKey: CURSOR_KEY,
      now: () => now,
      limits: { bodyMaxActive: 2 },
    });
    const first = await createTestArtifact(store, { owner: OWNER, canonical: "first" });
    now += 1;
    const second = await createTestArtifact(store, { owner: OWNER, canonical: "second" });
    now += 1;
    await store.read({ ...OWNER, outputRef: first.outputRef });
    now += 1;
    await createTestArtifact(store, { owner: OWNER, canonical: "third" });
    await store.dispose();

    const restarted = makeStore(directory, {
      rootDir: directory,
      cursorKey: CURSOR_KEY,
      now: () => now,
      limits: { bodyMaxActive: 2 },
    });
    await expect(
      restarted.read({ ...OWNER, outputRef: second.outputRef }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_EVICTED" });
    expect((await restarted.stats()).active).toBe(2);
    const stats = await restarted.stats();
    expect(stats.bodyBytes).toBe("first".length + "third".length);
    expect(stats.ledgerBytes).toBeGreaterThan(0);
    await restarted.dispose();
  });

  test("fails closed and deletes malformed or extra-field tombstones on restart", async () => {
    for (const [label, mutate] of [
      ["malformed", () => "not-json"],
      ["extra-field", (serialized: string) => JSON.stringify({ ...JSON.parse(serialized), unexpected: true })],
    ] as const) {
      let now = 1_000;
      const directory = join(TEST_ROOT, `invalid-tombstone-${label}`);
      const store = makeStore(directory, {
        rootDir: directory,
        cursorKey: CURSOR_KEY,
        now: () => now,
        limits: { bodyTtlMs: 100, tombstoneTtlMs: 100 },
      });
      const created = await createTestArtifact(store, { owner: OWNER, canonical: label });
      now = 1_101;
      await expect(store.read({ ...OWNER, outputRef: created.outputRef })).rejects.toMatchObject({
        code: "TOOL_OUTPUT_EXPIRED",
      });
      await store.dispose();

      const tombstonePath = join(directory, "tombstones", `${created.outputRef}.json`);
      const serialized = await readFile(tombstonePath, "utf8");
      await writeFile(tombstonePath, mutate(serialized));
      const restarted = makeStore(directory, {
        rootDir: directory,
        cursorKey: CURSOR_KEY,
        now: () => now,
        limits: { bodyTtlMs: 100, tombstoneTtlMs: 100 },
      });
      await expect(restarted.read({ ...OWNER, outputRef: created.outputRef })).rejects.toMatchObject({
        code: "TOOL_OUTPUT_NOT_FOUND",
      });
      expect(await Bun.file(tombstonePath).exists()).toBe(false);
      await restarted.dispose();
    }
  });

  test("applies the 500 MiB policy to bodies without charging metadata or tombstones", async () => {
    let now = 1;
    const directory = join(TEST_ROOT, "body-quota");
    const store = makeStore(directory, {
      rootDir: directory,
      now: () => now,
      limits: { bodyQuotaBytes: 10 },
    });
    const first = await createTestArtifact(store, { owner: OWNER, canonical: "12345678" });
    now += 1;
    const second = await createTestArtifact(store, { owner: OWNER, canonical: "abcdefgh" });
    await expect(store.read({ ...OWNER, outputRef: first.outputRef })).rejects.toMatchObject({
      code: "TOOL_OUTPUT_EVICTED",
    });
    expect(await readAll(store, second.outputRef)).toBe("abcdefgh");
    const stats = await store.stats();
    expect(stats.bodyBytes).toBe(8);
    expect(stats.ledgerBytes).toBeGreaterThan(10);
    await store.dispose();
  });

  test("binds injected search cursors to scope, ref, and pattern", async () => {
    let receivedCursor: string | undefined;
    const runner: ArtifactSearchRunner = {
      async search(input) {
        receivedCursor = input.cursor;
        if (input.cursor !== undefined) return { matches: [] };
        return {
          matches: [
            {
              segment: "full",
              canonicalStart: 0,
              canonicalEnd: 6,
              snippet: "needle",
            },
          ],
          nextCursor: "runner-page-2",
        };
      },
    };
    const directory = join(TEST_ROOT, "search");
    const store = makeStore(directory, { rootDir: directory, cursorKey: CURSOR_KEY, searchRunner: runner });
    const created = await createTestArtifact(store, { owner: OWNER, canonical: "needle and haystack" });
    const first = await store.search({ ...OWNER, outputRef: created.outputRef, pattern: "needle" });
    expect(first.matches).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    await store.search({
      ...OWNER,
      outputRef: created.outputRef,
      pattern: "needle",
      cursor: first.nextCursor,
    });
    expect(receivedCursor).toBe("runner-page-2");
    await expect(
      store.search({
        ...OWNER,
        outputRef: created.outputRef,
        pattern: "different",
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_INVALID_CURSOR" });
    await store.dispose();
  });

  test("keeps every read/search response within item and 50 KiB content limits", async () => {
    const store = new ToolOutputArtifactStore({ rootDir: join(TEST_ROOT, "response-bounds") });
    const readArtifact = await createTestArtifact(store, { owner: OWNER, canonical: "r".repeat(60 * 1024) });
    const readPage = await store.read({ ...OWNER, outputRef: readArtifact.outputRef, limit: 1_000 });
    expect(readPage.records.length).toBeLessThanOrEqual(1_000);
    expect(
      readPage.records.reduce(
        (sum, record) => sum + new TextEncoder().encode(record.text).byteLength,
        0,
      ),
    ).toBeLessThanOrEqual(50 * 1024);
    expect(readPage.nextCursor).toBeDefined();

    const searchArtifact = await createTestArtifact(store, {
      owner: OWNER,
      canonical: Array.from({ length: 60 }, () => "x".repeat(1_024)).join("\n"),
    });
    const searchPage = await store.search({
      ...OWNER,
      outputRef: searchArtifact.outputRef,
      pattern: "x+",
      limit: 100,
    });
    expect(searchPage.matches.length).toBeLessThanOrEqual(100);
    expect(
      searchPage.matches.reduce(
        (sum, match) => sum + new TextEncoder().encode(match.snippet).byteLength,
        0,
      ),
    ).toBeLessThanOrEqual(50 * 1024);
    expect(searchPage.nextCursor).toBeDefined();
    await store.dispose();
  });

  test("paginates across the exact 50 KiB read cut without splitting UTF-8", async () => {
    const store = new ToolOutputArtifactStore({ rootDir: join(TEST_ROOT, "read-utf8-boundary") });
    const content = `${"a".repeat(50 * 1024 - 1)}😀TAIL`;
    const created = await createTestArtifact(store, { owner: OWNER, canonical: content });
    const first = await store.read({ ...OWNER, outputRef: created.outputRef });
    expect(first.records).toHaveLength(1);
    expect(first.records[0]?.text).not.toContain("�");
    expect(Buffer.byteLength(first.records[0]?.text ?? "")).toBe(50 * 1024 - 1);
    expect(first.nextCursor).toBeDefined();
    const second = await store.read({
      ...OWNER,
      outputRef: created.outputRef,
      cursor: first.nextCursor,
    });
    expect(second.records[0]?.text).toBe("😀TAIL");
    expect(second.nextCursor).toBeUndefined();
    expect(`${first.records[0]?.text}${second.records[0]?.text}`).toBe(content);
    await store.dispose();
  });

  test("reads a large single-line segment through bounded positioned windows and short reads", async () => {
    const pageBytes = 4 * 1024;
    const requestedLengths: number[] = [];
    const nativeReadLengths: number[] = [];
    const openReadHandle: NonNullable<
      ConstructorParameters<typeof ToolOutputArtifactStore>[0]["openReadHandle"]
    > = async (path) => {
      const handle = await open(path, "r");
      return {
        stat: () => handle.stat(),
        async read(buffer, offset, length, position) {
          requestedLengths.push(length);
          const boundedLength = Math.min(length, 17);
          nativeReadLengths.push(boundedLength);
          return handle.read(buffer, offset, boundedLength, position);
        },
        close: () => handle.close(),
      };
    };
    const store = makeStore(join(TEST_ROOT, "bounded-read-windows"), {
      openReadHandle,
      limits: {
        artifactMaxBytes: 512 * 1024,
        bodyQuotaBytes: 1024 * 1024,
        readMaxBytes: pageBytes,
      },
    });
    const content = `HEAD:${"abc😀".repeat(40_000)}:TAIL`;
    const created = await createTestArtifact(store, { owner: OWNER, canonical: content });
    expect(created.metadata.completeness).toBe("complete");

    let cursor: string | undefined;
    let expectedCanonicalOffset = 0;
    let reconstructed = "";
    let recordIndex = 0;
    do {
      const page = await store.read({
        ...OWNER,
        outputRef: created.outputRef,
        cursor,
        maxContentBytes: pageBytes,
      });
      expect(page.records).toHaveLength(1);
      const record = page.records[0]!;
      const recordBytes = Buffer.byteLength(record.text);
      expect(record.canonicalStart).toBe(expectedCanonicalOffset);
      expect(record.canonicalEnd).toBe(record.canonicalStart + recordBytes);
      expect(record.continuedFromPrevious).toBe(recordIndex > 0);
      expect(record.continuesNext).toBe(page.nextCursor !== undefined);
      expect(record.text).not.toContain("�");
      reconstructed += record.text;
      expectedCanonicalOffset = record.canonicalEnd;
      recordIndex += 1;
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(reconstructed).toBe(content);
    expect(expectedCanonicalOffset).toBe(Buffer.byteLength(content));
    expect(requestedLengths.length).toBeGreaterThan(recordIndex);
    expect(Math.max(...requestedLengths)).toBeLessThanOrEqual(pageBytes + 4);
    expect(Math.max(...nativeReadLengths)).toBe(17);
    await store.dispose();
  });

  test("freezes family search refs and releases pins on the terminal page", async () => {
    const runner: ArtifactSearchRunner = {
      async search(input) {
        const segment = input.segments[0]!;
        return {
          matches: [{
            segment: segment.kind,
            canonicalStart: segment.canonicalStart,
            canonicalEnd: segment.canonicalStart + 1,
            snippet: "x",
          }],
        };
      },
    };
    const directory = join(TEST_ROOT, "family-search");
    const store = makeStore(directory, { rootDir: directory, searchRunner: runner });
    const initial = [
      await createTestArtifact(store, { owner: OWNER, canonical: "a" }),
      await createTestArtifact(store, { owner: OWNER, canonical: "b" }),
      await createTestArtifact(store, { owner: OWNER, canonical: "c" }),
    ];
    const first = await store.search({ ...OWNER, pattern: "x", limit: 1 });
    expect(first.matches).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    expect((await store.stats()).pinnedRefs).toBe(3);
    const late = await createTestArtifact(store, { owner: OWNER, canonical: "late" });

    const found = new Set(first.matches.map((match) => match.outputRef));
    let cursor = first.nextCursor;
    while (cursor !== undefined) {
      const page = await store.search({ ...OWNER, pattern: "x", cursor, limit: 1 });
      for (const match of page.matches) found.add(match.outputRef);
      cursor = page.nextCursor;
    }
    expect(found).toEqual(new Set(initial.map((item) => item.outputRef)));
    expect(found.has(late.outputRef)).toBe(false);
    expect((await store.stats()).leases).toBe(0);
    expect((await store.stats()).pinnedRefs).toBe(0);
    await store.dispose();
  });

  test("validates family page limits before lease creation or cursor mutation", async () => {
    const runner: ArtifactSearchRunner = {
      async search(input) {
        const segment = input.segments[0]!;
        return {
          matches: [{
            segment: segment.kind,
            canonicalStart: segment.canonicalStart,
            canonicalEnd: segment.canonicalStart + 1,
            snippet: "x",
          }],
        };
      },
    };
    const store = makeStore(join(TEST_ROOT, "family-invalid-limits"), { searchRunner: runner });
    await createTestArtifact(store, { owner: OWNER, canonical: "a" });
    await createTestArtifact(store, { owner: OWNER, canonical: "b" });

    await expect(store.search({ ...OWNER, pattern: "x", limit: 0 })).rejects.toMatchObject({
      code: "TOOL_OUTPUT_POLICY_VIOLATION",
    });
    await expect(
      store.search({ ...OWNER, pattern: "x", maxContentBytes: 1_023 }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_POLICY_VIOLATION" });
    expect(await store.stats()).toMatchObject({ leases: 0, pinnedRefs: 0 });

    const first = await store.search({ ...OWNER, pattern: "x", limit: 1 });
    expect(first.nextCursor).toBeDefined();
    expect(await store.stats()).toMatchObject({ leases: 1, pinnedRefs: 2 });
    await expect(
      store.search({ ...OWNER, pattern: "x", cursor: first.nextCursor, limit: 0 }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_POLICY_VIOLATION" });
    await expect(
      store.search({
        ...OWNER,
        pattern: "x",
        cursor: first.nextCursor,
        maxContentBytes: 1_023,
      }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_POLICY_VIOLATION" });
    await expect(
      store.search({ ...OWNER, pattern: "different", cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_INVALID_CURSOR" });
    expect(await store.stats()).toMatchObject({ leases: 1, pinnedRefs: 2 });

    const terminal = await store.search({
      ...OWNER,
      pattern: "x",
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(terminal.matches).toHaveLength(1);
    expect(terminal.nextCursor).toBeUndefined();
    expect(await store.stats()).toMatchObject({ leases: 0, pinnedRefs: 0 });
    await store.dispose();
  });

  test("continues a family query when the next artifact cannot fit the remaining content budget", async () => {
    const snippet = "x".repeat(1_023);
    const runner: ArtifactSearchRunner = {
      async search(input) {
        const segment = input.segments[0]!;
        return {
          matches: [{
            segment: segment.kind,
            canonicalStart: segment.canonicalStart,
            canonicalEnd: segment.canonicalStart + 1,
            snippet,
          }],
        };
      },
    };
    const store = makeStore(join(TEST_ROOT, "family-small-remaining-budget"), {
      searchRunner: runner,
    });
    await createTestArtifact(store, { owner: OWNER, canonical: "a" });
    await createTestArtifact(store, { owner: OWNER, canonical: "b" });

    const first = await store.search({
      ...OWNER,
      pattern: "x",
      limit: 2,
      maxContentBytes: 1_024,
    });
    expect(first.matches).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    const second = await store.search({
      ...OWNER,
      pattern: "x",
      cursor: first.nextCursor,
      limit: 2,
      maxContentBytes: 1_024,
    });
    expect(second.matches).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.matches, ...second.matches].map((match) => match.outputRef)).size).toBe(2);
    await store.dispose();
  });

  test.each([
    ["snapshot ref cap", { familyLeaseMaxRefs: 1 }],
    ["global pinned-ref cap", { familyLeaseMaxPinnedRefs: 1 }],
  ] as const)("rejects family lease admission at the %s without leaking pins", async (_label, limits) => {
    const store = makeStore(join(TEST_ROOT, `family-${_label.replaceAll(" ", "-")}`), {
      limits,
    });
    await createTestArtifact(store, { owner: OWNER, canonical: "a" });
    await createTestArtifact(store, { owner: OWNER, canonical: "b" });
    await expect(store.search({ ...OWNER, pattern: "x", limit: 1 })).rejects.toMatchObject({
      code: "TOOL_OUTPUT_UNAVAILABLE",
    });
    expect(await store.stats()).toMatchObject({ leases: 0, pinnedRefs: 0 });
    await store.dispose();
  });

  test("revokes the oldest family lease when pinned refs block body quota", async () => {
    const runner: ArtifactSearchRunner = {
      async search(input) {
        const segment = input.segments[0]!;
        return {
          matches: [{
            segment: segment.kind,
            canonicalStart: segment.canonicalStart,
            canonicalEnd: segment.canonicalStart + 1,
            snippet: "x",
          }],
        };
      },
    };
    const directory = join(TEST_ROOT, "lease-pressure");
    const store = makeStore(directory, {
      rootDir: directory,
      searchRunner: runner,
      limits: { bodyMaxActive: 2 },
    });
    await createTestArtifact(store, { owner: OWNER, canonical: "a" });
    await createTestArtifact(store, { owner: OWNER, canonical: "b" });
    const page = await store.search({ ...OWNER, pattern: "x", limit: 1 });
    expect(page.nextCursor).toBeDefined();
    await createTestArtifact(store, { owner: OWNER, canonical: "c" });
    await expect(
      store.search({ ...OWNER, pattern: "x", cursor: page.nextCursor, limit: 1 }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_INVALID_CURSOR" });
    expect((await store.stats()).active).toBe(2);
    await store.dispose();
  });

  test("revokes the oldest lease before evicting an available unpinned LRU body", async () => {
    let now = 1;
    const runner: ArtifactSearchRunner = {
      async search(input) {
        const segment = input.segments[0]!;
        return {
          matches: [{
            segment: segment.kind,
            canonicalStart: segment.canonicalStart,
            canonicalEnd: segment.canonicalStart + 1,
            snippet: "x",
          }],
        };
      },
    };
    const oldestLeaseOwner: ArtifactOwner = {
      ...OWNER,
      rootSessionId: "root-oldest-lease",
    };
    const unpinnedOwner: ArtifactOwner = {
      ...OWNER,
      rootSessionId: "root-unpinned",
    };
    const survivingLeaseOwner: ArtifactOwner = {
      ...OWNER,
      rootSessionId: "root-surviving-lease",
    };
    const directory = join(TEST_ROOT, "lease-pressure-with-unpinned-body");
    const store = makeStore(directory, {
      rootDir: directory,
      now: () => now,
      searchRunner: runner,
      limits: { bodyMaxActive: 5 },
    });

    const oldestFirst = await createTestArtifact(store, {
      owner: oldestLeaseOwner,
      canonical: "oldest-first",
    });
    now += 1;
    const oldestLru = await createTestArtifact(store, {
      owner: oldestLeaseOwner,
      canonical: "oldest-lru",
    });
    now += 1;
    const oldestPage = await store.search({
      projectIdentity: oldestLeaseOwner.projectIdentity,
      rootSessionId: oldestLeaseOwner.rootSessionId,
      pattern: "x",
      limit: 1,
    });
    expect(oldestPage.nextCursor).toBeDefined();

    now += 1;
    const unpinned = await createTestArtifact(store, {
      owner: unpinnedOwner,
      canonical: "unpinned",
    });
    now += 1;
    await createTestArtifact(store, {
      owner: survivingLeaseOwner,
      canonical: "surviving-first",
    });
    now += 1;
    await createTestArtifact(store, {
      owner: survivingLeaseOwner,
      canonical: "surviving-second",
    });
    now += 1;
    const survivingPage = await store.search({
      projectIdentity: survivingLeaseOwner.projectIdentity,
      rootSessionId: survivingLeaseOwner.rootSessionId,
      pattern: "x",
      limit: 1,
    });
    expect(survivingPage.nextCursor).toBeDefined();
    expect(await store.stats()).toMatchObject({
      active: 5,
      tombstones: 0,
      leases: 2,
      pinnedRefs: 4,
    });

    now += 1;
    const protectedFinalized = await createTestArtifact(store, {
      owner: unpinnedOwner,
      canonical: "protected-finalized",
    });

    await expect(
      store.search({
        projectIdentity: oldestLeaseOwner.projectIdentity,
        rootSessionId: oldestLeaseOwner.rootSessionId,
        pattern: "x",
        cursor: oldestPage.nextCursor,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_INVALID_CURSOR" });
    await expect(store.read({ ...oldestLeaseOwner, outputRef: oldestLru.outputRef }))
      .rejects.toMatchObject({ code: "TOOL_OUTPUT_EVICTED" });
    expect(await readAll(store, oldestFirst.outputRef, oldestLeaseOwner)).toBe("oldest-first");
    expect(await readAll(store, unpinned.outputRef, unpinnedOwner)).toBe("unpinned");
    expect(await readAll(store, protectedFinalized.outputRef, unpinnedOwner))
      .toBe("protected-finalized");
    expect(await store.stats()).toMatchObject({
      active: 5,
      tombstones: 1,
      leases: 1,
      pinnedRefs: 2,
    });

    const survivingTerminalPage = await store.search({
      projectIdentity: survivingLeaseOwner.projectIdentity,
      rootSessionId: survivingLeaseOwner.rootSessionId,
      pattern: "x",
      cursor: survivingPage.nextCursor,
      limit: 1,
    });
    expect(survivingTerminalPage.nextCursor).toBeUndefined();
    expect(await store.stats()).toMatchObject({
      active: 5,
      tombstones: 1,
      leases: 0,
      pinnedRefs: 0,
    });
    await store.dispose();
  });

  test("expires family leases after five-minute-equivalent fake time", async () => {
    let now = 0;
    const runner: ArtifactSearchRunner = {
      async search(input) {
        const segment = input.segments[0]!;
        return {
          matches: [{
            segment: segment.kind,
            canonicalStart: segment.canonicalStart,
            canonicalEnd: segment.canonicalStart + 1,
            snippet: "x",
          }],
        };
      },
    };
    const directory = join(TEST_ROOT, "lease-ttl");
    const store = makeStore(directory, {
      rootDir: directory,
      now: () => now,
      searchRunner: runner,
      limits: { familyLeaseTtlMs: 10 },
    });
    await createTestArtifact(store, { owner: OWNER, canonical: "a" });
    await createTestArtifact(store, { owner: OWNER, canonical: "b" });
    const first = await store.search({ ...OWNER, pattern: "x", limit: 1 });
    now = 11;
    await expect(
      store.search({ ...OWNER, pattern: "x", cursor: first.nextCursor, limit: 1 }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_INVALID_CURSOR" });
    expect((await store.stats()).pinnedRefs).toBe(0);
    await store.dispose();
  });

  test("lets TTL revoke an in-flight search instead of pinning expired data", async () => {
    let now = 10;
    let resolveSearch!: (value: { matches: [] }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runner: ArtifactSearchRunner = {
      async search() {
        markStarted();
        return new Promise<{ matches: [] }>((resolve) => {
          resolveSearch = resolve;
        });
      },
    };
    const directory = join(TEST_ROOT, "ttl-priority");
    const store = makeStore(directory, {
      rootDir: directory,
      now: () => now,
      searchRunner: runner,
      limits: { bodyTtlMs: 100 },
    });
    const created = await createTestArtifact(store, { owner: OWNER, canonical: "needle" });
    const searching = store.search({ ...OWNER, outputRef: created.outputRef, pattern: "needle" });
    await started;
    now = 111;
    await store.cleanup();
    expect((await store.stats()).active).toBe(0);
    resolveSearch({ matches: [] });
    await expect(searching).rejects.toMatchObject({ code: "TOOL_OUTPUT_EXPIRED" });
    await store.dispose();
  });

  test("deletes only artifacts produced by the requested Session subtree", async () => {
    const store = makeStore(join(TEST_ROOT, "delete"));
    const childA = await createTestArtifact(store, { owner: OWNER, canonical: "a" });
    const childB = await createTestArtifact(store, {
      owner: { ...OWNER, producerSessionId: "child-b" },
      canonical: "b",
    });
    expect(await store.deleteProducerSessions(OWNER, new Set(["child-a"]))).toBe(1);
    await expect(store.read({ ...OWNER, outputRef: childA.outputRef })).rejects.toMatchObject({
      code: "TOOL_OUTPUT_NOT_FOUND",
    });
    expect(await readAll(store, childB.outputRef)).toBe("b");
    await store.dispose();
  });

  test("rejects new artifacts when the 100k-equivalent ledger entry admission is full", async () => {
    const directory = join(TEST_ROOT, "ledger-count");
    const store = makeStore(directory, {
      rootDir: directory,
      limits: { ledgerMaxEntries: 1 },
    });
    const first = await createTestArtifact(store, { owner: OWNER, canonical: "first" });
    await expect(createTestArtifact(store, { owner: OWNER, canonical: "second" })).rejects.toMatchObject({
      code: "TOOL_OUTPUT_UNAVAILABLE",
    });
    await store.deleteProducerSessions(OWNER, new Set([OWNER.producerSessionId]));
    expect((await createTestArtifact(store, { owner: OWNER, canonical: "second" })).outputRef).toHaveLength(22);
    await expect(store.read({ ...OWNER, outputRef: first.outputRef })).rejects.toMatchObject({
      code: "TOOL_OUTPUT_NOT_FOUND",
    });
    await store.dispose();
  });

  test("rejects admission when strict metadata would exceed the 64 MiB-equivalent ledger", async () => {
    const directory = join(TEST_ROOT, "ledger-bytes");
    const store = makeStore(directory, {
      rootDir: directory,
      limits: { ledgerMaxBytes: 128 },
    });
    await expect(createTestArtifact(store, { owner: OWNER, canonical: "body" })).rejects.toMatchObject({
      code: "TOOL_OUTPUT_UNAVAILABLE",
    });
    expect((await store.stats()).active).toBe(0);
    await store.dispose();
  });

  test("serializes concurrent ledger admission so exactly one slot is committed", async () => {
    const directory = join(TEST_ROOT, "ledger-concurrent");
    const store = makeStore(directory, {
      rootDir: directory,
      limits: { ledgerMaxEntries: 1 },
    });
    const results = await Promise.allSettled([
      createTestArtifact(store, { owner: OWNER, canonical: "first" }),
      createTestArtifact(store, { owner: OWNER, canonical: "second" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await store.stats()).active).toBe(1);
    expect(await store.countRecoverable(OWNER)).toBe(1);
    await store.dispose();
  });

  test("serializes concurrent family lease admission and revokes the oldest cursor", async () => {
    const runner: ArtifactSearchRunner = {
      async search(input) {
        const segment = input.segments[0]!;
        return {
          matches: [{
            segment: segment.kind,
            canonicalStart: segment.canonicalStart,
            canonicalEnd: segment.canonicalStart + 1,
            snippet: "x",
          }],
        };
      },
    };
    const directory = join(TEST_ROOT, "lease-concurrent");
    const store = makeStore(directory, {
      rootDir: directory,
      searchRunner: runner,
      limits: { familyLeaseMaxPerFamily: 1, familyLeaseMaxGlobal: 1 },
    });
    await createTestArtifact(store, { owner: OWNER, canonical: "a" });
    await createTestArtifact(store, { owner: OWNER, canonical: "b" });
    const firstPromise = store.search({ ...OWNER, pattern: "x", limit: 1 });
    const secondPromise = store.search({ ...OWNER, pattern: "x", limit: 1 });
    const results = await Promise.allSettled([firstPromise, secondPromise]);
    const fulfilled = results.find((result) => result.status === "fulfilled");
    const rejected = results.find((result) => result.status === "rejected");
    expect(fulfilled?.status).toBe("fulfilled");
    expect(rejected?.status).toBe("rejected");
    if (fulfilled?.status !== "fulfilled") throw new Error("Expected one surviving lease");
    expect(fulfilled.value.nextCursor).toBeDefined();
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toMatchObject({
      code: "TOOL_OUTPUT_INVALID_CURSOR",
    });
    expect((await store.stats()).leases).toBe(1);
    expect((await store.stats()).pinnedRefs).toBe(2);
    const terminal = await store.search({
      ...OWNER,
      pattern: "x",
      cursor: fulfilled.value.nextCursor,
      limit: 10,
    });
    expect(terminal.nextCursor).toBeUndefined();
    expect((await store.stats()).leases).toBe(0);
    await store.dispose();
  });
});
