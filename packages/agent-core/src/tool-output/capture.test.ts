import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolOutputArtifactStore } from "./artifact-store";
import {
  StreamingToolOutputCapture,
  type CapturedArtifactDraft,
} from "./capture";
import type { StreamingTextRedactor } from "../security";
import type { ArtifactOwner, CreatedArtifact } from "./artifact-types";

const ROOT = join(tmpdir(), "archcode-capture-tests", crypto.randomUUID());
const OWNER: ArtifactOwner = {
  projectIdentity: createHash("sha256").update("capture-project").digest("hex"),
  rootSessionId: "root",
  producerSessionId: "producer",
};

function fakeCreated(draft: CapturedArtifactDraft): CreatedArtifact {
  const outputRef = "AAAAAAAAAAAAAAAAAAAAAA" as CreatedArtifact["outputRef"];
  return {
    outputRef,
    metadata: {
      outputRef,
      createdAt: 0,
      expiresAt: 1,
      completeness: draft.omitted.bytes === 0 ? "complete" : "partial",
      observed: draft.observed,
      canonical: draft.canonical,
      stored: draft.stored,
      omitted: draft.omitted,
    },
    projection: draft.projection,
  };
}

function identityRedactor(): StreamingTextRedactor {
  return { push: (text) => text, finish: () => "" };
}

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("StreamingToolOutputCapture", () => {
  test("completes a small result inline without returning a second full string", async () => {
    const store = new ToolOutputArtifactStore({ rootDir: join(ROOT, "inline") });
    const capture = await store.beginCapture({ owner: OWNER, redactor: identityRedactor() });
    await capture.write(new Uint8Array([0xf0, 0x9f]));
    await capture.write(new Uint8Array([0x98, 0x80]));
    await capture.write(" ok");
    const completed = await capture.complete();
    expect(completed.artifactRequired).toBe(false);
    expect(completed.projection.preview).toBe("😀 ok");
    expect(completed.canonical.bytes).toBe(new TextEncoder().encode("😀 ok").byteLength);
    await expect(capture.commit(completed)).rejects.toMatchObject({
      code: "TOOL_OUTPUT_POLICY_VIOLATION",
    });
    await capture.discard(completed);
    expect(capture.state).toBe("discarded");
    expect((await store.stats()).active).toBe(0);
    await store.dispose();
  });

  test("persists only streaming-redacted text across arbitrary secret chunk splits", async () => {
    const tempDir = join(ROOT, "redacted");
    await mkdir(tempDir);
    const secret = "secret-value-123";
    let buffered = "";
    const redactor: StreamingTextRedactor = {
      push(text) {
        buffered += text;
        return "";
      },
      finish() {
        return buffered.replaceAll(secret, "[REDACTED]");
      },
    };
    const capture = new StreamingToolOutputCapture({
      tempDir,
      input: { owner: OWNER, redactor },
      committer: { async commit(draft) { return fakeCreated(draft); } },
    });
    const raw = new TextEncoder().encode(`before:${secret}:after`);
    for (const byte of raw) await capture.write(Uint8Array.of(byte));
    const completed = await capture.complete();
    expect(completed.projection.preview).toBe("before:[REDACTED]:after");
    expect(completed.observed.bytes).toBe(raw.byteLength);
    expect(completed.canonical.bytes).toBe(
      new TextEncoder().encode("before:[REDACTED]:after").byteLength,
    );
    const persisted = await readFile(join(tempDir, "body.txt"), "utf8");
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("[REDACTED]");
    await capture.discard(completed);
  });

  test("commits a large capture only after Registry chooses artifact recovery", async () => {
    const store = new ToolOutputArtifactStore({ rootDir: join(ROOT, "artifact") });
    const capture = await store.beginCapture({ owner: OWNER, redactor: identityRedactor() });
    const content = `HEAD_SENTINEL\n${"x".repeat(70 * 1024)}\nTAIL_SENTINEL`;
    for (let offset = 0; offset < content.length; offset += 3_001) {
      expect(await capture.write(content.slice(offset, offset + 3_001))).toBe("accepted");
    }
    const completed = await capture.complete();
    expect(completed.artifactRequired).toBe(true);
    expect(completed.projection.preview).toContain("HEAD_SENTINEL");
    expect(completed.projection.preview).toContain("TAIL_SENTINEL");
    const created = await capture.commit(completed);
    expect(created.outputRef).toHaveLength(22);
    expect(capture.state).toBe("finalized");
    expect((await store.stats()).active).toBe(1);
    await store.dispose();
  });

  test("preserves an exact-size artifact when a code point crosses the head boundary", async () => {
    const tempDir = join(ROOT, "utf8-boundary");
    await mkdir(tempDir);
    const text = `${"a".repeat(51_199)}😀${"b".repeat(10_237)}`;
    const bytes = new TextEncoder().encode(text);
    expect(bytes.byteLength).toBe(60 * 1024);
    let committedDraft: CapturedArtifactDraft | undefined;
    let committedBody = "";
    const capture = new StreamingToolOutputCapture({
      tempDir,
      input: { owner: OWNER, redactor: identityRedactor() },
      artifactMaxBytes: 60 * 1024,
      headMaxBytes: 50 * 1024,
      tailMaxBytes: 10 * 1024,
      committer: {
        async commit(draft) {
          committedDraft = draft;
          committedBody = await readFile(join(draft.tempDir, "body.txt"), "utf8");
          return fakeCreated(draft);
        },
      },
    });
    for (let offset = 0; offset < bytes.byteLength; offset += 4_093) {
      await capture.write(bytes.subarray(offset, offset + 4_093));
    }
    const completed = await capture.complete();
    expect(completed.artifactRequired).toBe(true);
    await capture.commit(completed);
    expect(committedDraft?.omitted.bytes).toBe(0);
    expect(committedDraft?.segments).toHaveLength(1);
    expect(committedBody).toBe(text);
  });

  test("keeps only ordered head/tail files after a streaming artifact exceeds its cap", async () => {
    const tempDir = join(ROOT, "rolling-tail");
    await mkdir(tempDir);
    const text = `HEAD_SENTINEL:${"x".repeat(70 * 1024)}:TAIL_SENTINEL😀`;
    let committedDraft: CapturedArtifactDraft | undefined;
    let head = "";
    let tail = "";
    const capture = new StreamingToolOutputCapture({
      tempDir,
      input: { owner: OWNER, redactor: identityRedactor() },
      artifactMaxBytes: 1_024,
      headMaxBytes: 768,
      tailMaxBytes: 256,
      committer: {
        async commit(draft) {
          committedDraft = draft;
          head = await readFile(join(draft.tempDir, "head.txt"), "utf8");
          tail = await readFile(join(draft.tempDir, "tail.txt"), "utf8");
          return fakeCreated(draft);
        },
      },
    });
    const bytes = new TextEncoder().encode(text);
    for (let offset = 0; offset < bytes.byteLength; offset += 997) {
      await capture.write(bytes.subarray(offset, offset + 997));
    }
    const completed = await capture.complete();
    await capture.commit(completed);
    expect(committedDraft?.segments).toHaveLength(2);
    expect(committedDraft?.stored.bytes).toBeLessThanOrEqual(1_024);
    expect(committedDraft?.omitted.bytes).toBeGreaterThan(0);
    expect(head.startsWith("HEAD_SENTINEL")).toBe(true);
    expect(tail.endsWith("TAIL_SENTINEL😀")).toBe(true);
    expect(tail).not.toContain("�");
  });

  test("repairs a wrapped tail whose ring position lands inside a code point", async () => {
    const tempDir = join(ROOT, "tail-wrap-boundary");
    await mkdir(tempDir);
    let tail = "";
    let draft: CapturedArtifactDraft | undefined;
    const capture = new StreamingToolOutputCapture({
      tempDir,
      input: { owner: OWNER, redactor: identityRedactor() },
      artifactMaxBytes: 15,
      headMaxBytes: 8,
      tailMaxBytes: 7,
      committer: {
        async commit(value) {
          draft = value;
          tail = await readFile(join(value.tempDir, "tail.txt"), "utf8");
          return fakeCreated(value);
        },
      },
    });
    for (const chunk of ["12345678", "😀".repeat(13_000), "😀Z"]) {
      await capture.write(chunk);
    }
    const completed = await capture.complete();
    await capture.commit(completed);
    expect(tail).toBe("😀Z");
    expect(tail).not.toContain("�");
    expect(draft?.segments.at(-1)?.bytes).toBe(5);
    expect(draft?.segments.at(-1)?.canonicalStart).toBe(completed.canonical.bytes - 5);
  });

  test("counts omitted lines from the actual head-tail gap boundaries", async () => {
    const tempDir = join(ROOT, "omitted-lines");
    await mkdir(tempDir);
    const capture = new StreamingToolOutputCapture({
      tempDir,
      input: { owner: OWNER, redactor: identityRedactor() },
      artifactMaxBytes: 8,
      headMaxBytes: 4,
      tailMaxBytes: 4,
      committer: {
        async commit(value) {
          return fakeCreated(value);
        },
      },
    });
    await capture.write("H\nA\nO\nP\nB\nT\n");
    const completed = await capture.complete();
    expect(completed.omitted).toEqual({ bytes: 4, lines: 2 });
    expect(completed.canonical.lines).toBe(6);
    expect(completed.stored.lines).toBe(4);
    await capture.discard(completed);
  });

  test("keeps default 63 MiB head and 1 MiB tail cuts on exact UTF-8 boundaries", async () => {
    const tempDir = join(ROOT, "default-large-boundaries");
    await mkdir(tempDir);
    let draft: CapturedArtifactDraft | undefined;
    let tail = "";
    const capture = new StreamingToolOutputCapture({
      tempDir,
      input: { owner: OWNER, redactor: identityRedactor() },
      committer: {
        async commit(value) {
          draft = value;
          tail = await readFile(join(value.tempDir, "tail.txt"), "utf8");
          return fakeCreated(value);
        },
      },
    });
    const oneMiB = "h".repeat(1024 * 1024);
    for (let index = 0; index < 62; index += 1) await capture.write(oneMiB);
    await capture.write("h".repeat(1024 * 1024 - 1));
    await capture.write("😀".repeat(1024 * 1024 / 4 + 2));
    await capture.write("END");
    const completed = await capture.complete();
    await capture.commit(completed);

    expect((await stat(join(tempDir, "head.txt"))).size).toBe(63 * 1024 * 1024 - 1);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(1024 * 1024);
    expect(tail).not.toContain("�");
    expect(tail.startsWith("😀")).toBe(true);
    expect(tail.endsWith("END")).toBe(true);
    expect(draft?.segments[0]?.canonicalEnd).toBe(63 * 1024 * 1024 - 1);
    expect(draft?.segments[1]?.canonicalStart).toBe(completed.canonical.bytes - Buffer.byteLength(tail));
    expect(completed.projection.previewBytes).toBeLessThanOrEqual(50 * 1024);
    expect(completed.projection.preview).not.toContain("�");
  }, 30_000);

  test("permanently enters discard mode when the bounded queue cannot drain", async () => {
    const tempDir = join(ROOT, "blocked-writer");
    await mkdir(tempDir);
    const never = new Promise<void>(() => undefined);
    const capture = new StreamingToolOutputCapture({
      tempDir,
      input: { owner: OWNER, redactor: identityRedactor() },
      queueMaxBytes: 4,
      queueWaitMs: 10,
      beforePersist: async () => never,
      committer: { async commit() { throw new Error("must not commit"); } },
    });
    expect(await capture.write("abcd")).toBe("accepted");
    expect(await capture.write("efgh")).toBe("discarded");
    expect(capture.state).toBe("discarding");
    expect(capture.signal.aborted).toBe(true);
    expect(capture.stats().discardedBytes).toBe(4);
    await expect(capture.complete()).rejects.toMatchObject({ code: "TOOL_OUTPUT_UNAVAILABLE" });
    await capture.abort();
  });

  test("atomically reserves queue capacity across concurrent 64 KiB writes", async () => {
    const tempDir = join(ROOT, "concurrent-reservation");
    await mkdir(tempDir);
    const never = new Promise<void>(() => undefined);
    const capture = new StreamingToolOutputCapture({
      tempDir,
      input: { owner: OWNER, redactor: identityRedactor() },
      queueMaxBytes: 64 * 1024,
      queueWaitMs: 30,
      beforePersist: async () => never,
      committer: { async commit() { throw new Error("must not commit"); } },
    });
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const startedAt = Date.now();
    const first = capture.write(chunk);
    const second = capture.write(chunk);
    await Promise.resolve();
    expect(capture.stats().queuedBytes).toBe(64 * 1024);
    expect(await first).toBe("accepted");
    expect(await second).toBe("discarded");
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(capture.stats().queuedBytes).toBeLessThanOrEqual(64 * 1024);
    await capture.abort();
  });

  test("keeps preview head contiguous when a multibyte code point crosses 50 KiB", async () => {
    const tempDir = join(ROOT, "preview-boundary");
    await mkdir(tempDir);
    const capture = new StreamingToolOutputCapture({
      tempDir,
      input: { owner: OWNER, redactor: identityRedactor() },
      committer: { async commit(draft) { return fakeCreated(draft); } },
    });
    await capture.write("a".repeat(50 * 1024 - 1));
    await capture.write("😀");
    await capture.write("AFTER_BOUNDARY");
    const completed = await capture.complete();
    expect(completed.projection.preview).not.toContain("�");
    expect(completed.projection.preview).toContain("a".repeat(64));
    expect(completed.projection.preview).toContain("AFTER_BOUNDARY");
    expect(completed.projection.previewBytes).toBeLessThanOrEqual(50 * 1024);
    await capture.commit(completed);
  });

  test("revokes generation before a late commit can become visible", async () => {
    const tempDir = join(ROOT, "late-commit");
    await mkdir(tempDir);
    let resolveCommit!: (created: CreatedArtifact) => void;
    let generationIsActive!: () => boolean;
    const capture = new StreamingToolOutputCapture({
      tempDir,
      input: { owner: OWNER, redactor: identityRedactor() },
      commitWaitMs: 10,
      committer: {
        async commit(_draft: CapturedArtifactDraft, active) {
          generationIsActive = active;
          return new Promise<CreatedArtifact>((resolve) => {
            resolveCommit = resolve;
          });
        },
      },
    });
    await capture.write("x".repeat(60 * 1024));
    const completed = await capture.complete();
    expect(completed.artifactRequired).toBe(true);
    await expect(capture.commit(completed)).rejects.toMatchObject({ code: "TOOL_OUTPUT_UNAVAILABLE" });
    expect(generationIsActive()).toBe(false);
    resolveCommit(fakeCreated({
      tempDir,
      owner: OWNER,
      observed: completed.observed,
      canonical: completed.canonical,
      stored: completed.stored,
      omitted: completed.omitted,
      segments: [],
      projection: completed.projection,
    }));
    expect(capture.state).toBe("aborted");
  });
});
