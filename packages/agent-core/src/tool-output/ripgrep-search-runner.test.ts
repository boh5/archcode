import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RipgrepArtifactSearchRunner } from "./ripgrep-search-runner";

const ROOT = join(tmpdir(), "archcode-rg-output-tests", crypto.randomUUID());

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("RipgrepArtifactSearchRunner", () => {
  test("returns bounded matches and a strictly advancing cursor", async () => {
    const path = join(ROOT, "body.txt");
    await writeFile(path, "needle one\nother\nneedle two\n");
    const runner = new RipgrepArtifactSearchRunner();
    const base = {
      segments: [{ kind: "full" as const, path, canonicalStart: 0, canonicalEnd: 28 }],
      pattern: "needle",
      limit: 1,
      maxContentBytes: 50 * 1024,
      deadlineAt: Date.now() + 5_000,
      signal: new AbortController().signal,
    };
    const first = await runner.search(base);
    expect(first.matches).toHaveLength(1);
    expect(first.matches[0]?.snippet).toBe("needle");
    expect(first.nextCursor).toBeDefined();
    const second = await runner.search({ ...base, cursor: first.nextCursor });
    expect(second.matches).toHaveLength(1);
    expect(second.matches[0]!.canonicalStart).toBeGreaterThan(first.matches[0]!.canonicalStart);
    expect(second.nextCursor).toBeUndefined();
  });

  test.each(["^", "$", "a*"])("paginates zero-width pattern %s to terminal without duplicates", async (pattern) => {
    const path = join(ROOT, "zero.txt");
    await writeFile(path, "a\nb\n");
    const runner = new RipgrepArtifactSearchRunner();
    const base = {
      segments: [{ kind: "full", path, canonicalStart: 0, canonicalEnd: 4 }],
      pattern,
      limit: 1,
      maxContentBytes: 50 * 1024,
      deadlineAt: Date.now() + 5_000,
      signal: new AbortController().signal,
    } as const;
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 16; pageIndex += 1) {
      const page = await runner.search({ ...base, ...(cursor === undefined ? {} : { cursor }) });
      expect(page.matches.length).toBeLessThanOrEqual(1);
      for (const match of page.matches) {
        seen.push(`${match.canonicalStart}:${match.canonicalEnd}:${match.snippet}`);
      }
      if (page.nextCursor === undefined) {
        cursor = undefined;
        break;
      }
      expect(page.nextCursor).not.toBe(cursor);
      cursor = page.nextCursor;
    }
    expect(cursor).toBeUndefined();
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("discards an arbitrarily long match while retaining a 1 KiB snippet", async () => {
    const path = join(ROOT, "long.txt");
    await writeFile(path, "x".repeat(2 * 1024 * 1024));
    const runner = new RipgrepArtifactSearchRunner();
    const result = await runner.search({
      segments: [{ kind: "full", path, canonicalStart: 0, canonicalEnd: 2 * 1024 * 1024 }],
      pattern: "x+",
      limit: 1,
      maxContentBytes: 50 * 1024,
      deadlineAt: Date.now() + 5_000,
      signal: new AbortController().signal,
    });
    expect(result.matches[0]?.snippet.length).toBe(1_024);
    expect(result.matches[0]?.canonicalEnd).toBe(2 * 1024 * 1024);
  });

  test("cuts a multibyte snippet at the last UTF-8 boundary before 1 KiB", async () => {
    const path = join(ROOT, "multibyte.txt");
    const content = `a${"😀".repeat(300)}`;
    await writeFile(path, content);
    const runner = new RipgrepArtifactSearchRunner();
    const result = await runner.search({
      segments: [{ kind: "full", path, canonicalStart: 0, canonicalEnd: Buffer.byteLength(content) }],
      pattern: "a.*",
      limit: 1,
      maxContentBytes: 50 * 1024,
      deadlineAt: Date.now() + 5_000,
      signal: new AbortController().signal,
    });
    const snippet = result.matches[0]?.snippet ?? "";
    expect(snippet).not.toContain("�");
    expect(Buffer.byteLength(snippet)).toBeLessThanOrEqual(1_024);
    expect(snippet.endsWith("😀")).toBe(true);
  });
});
