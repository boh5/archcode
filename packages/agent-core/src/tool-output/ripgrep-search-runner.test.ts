import { describe, expect, test } from "bun:test";
import {
  RipgrepArtifactSearchRunner,
  type RipgrepArtifactSearchProcess,
} from "./ripgrep-search-runner";

function byteStream(...chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function createRunner(stdout: string, exitCode = 0): {
  readonly runner: RipgrepArtifactSearchRunner;
  readonly spawnedArgv: (readonly string[])[];
} {
  const spawnedArgv: (readonly string[])[] = [];
  const spawn = (argv: readonly string[]): RipgrepArtifactSearchProcess => {
    spawnedArgv.push(argv);
    return {
      stdout: byteStream(stdout),
      stderr: byteStream(),
      exited: Promise.resolve(exitCode),
      kill: () => undefined,
    };
  };
  return {
    runner: new RipgrepArtifactSearchRunner({
      binaryResolver: { resolve: async () => "/managed/bin/rg" },
      spawn,
    }),
    spawnedArgv,
  };
}

function baseSearch(pattern: string) {
  return {
    segments: [{
      kind: "full" as const,
      path: "/artifact/body.txt",
      canonicalStart: 0,
      canonicalEnd: 2 * 1024 * 1024,
    }],
    pattern,
    limit: 1,
    maxContentBytes: 50 * 1024,
    deadlineAt: Date.now() + 5_000,
    signal: new AbortController().signal,
  };
}

describe("RipgrepArtifactSearchRunner", () => {
  test("returns bounded matches and a strictly advancing cursor", async () => {
    const { runner, spawnedArgv } = createRunner("1:0:needle\n3:17:needle\n");
    const base = {
      ...baseSearch("needle"),
      segments: [{
        kind: "full" as const,
        path: "/artifact/body.txt",
        canonicalStart: 0,
        canonicalEnd: 28,
      }],
    };
    const first = await runner.search(base);
    expect(first.matches).toHaveLength(1);
    expect(first.matches[0]?.snippet).toBe("needle");
    expect(first.nextCursor).toBeDefined();
    const second = await runner.search({ ...base, cursor: first.nextCursor });
    expect(second.matches).toHaveLength(1);
    expect(second.matches[0]!.canonicalStart).toBeGreaterThan(first.matches[0]!.canonicalStart);
    expect(second.nextCursor).toBeUndefined();
    expect(spawnedArgv).toHaveLength(2);
    expect(spawnedArgv[0]).toEqual([
      "/managed/bin/rg",
      "--no-heading",
      "--color=never",
      "--line-number",
      "--byte-offset",
      "--only-matching",
      "--regexp",
      "needle",
      "/artifact/body.txt",
    ]);
  });

  test.each(["^", "$", "a*"])("paginates zero-width pattern %s to terminal without duplicates", async (pattern) => {
    const { runner } = createRunner("1:0:\n2:2:\n");
    const base = {
      ...baseSearch(pattern),
      segments: [{
        kind: "full" as const,
        path: "/artifact/zero.txt",
        canonicalStart: 0,
        canonicalEnd: 4,
      }],
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
    const content = "x".repeat(2 * 1024 * 1024);
    const { runner } = createRunner(`1:0:${content}\n`);
    const result = await runner.search(baseSearch("x+"));
    expect(result.matches[0]?.snippet.length).toBe(1_024);
    expect(result.matches[0]?.canonicalEnd).toBe(2 * 1024 * 1024);
  });

  test("cuts a multibyte snippet at the last UTF-8 boundary before 1 KiB", async () => {
    const content = `a${"😀".repeat(300)}`;
    const { runner } = createRunner(`1:0:${content}\n`);
    const result = await runner.search({
      ...baseSearch("a.*"),
      segments: [{
        kind: "full",
        path: "/artifact/multibyte.txt",
        canonicalStart: 0,
        canonicalEnd: Buffer.byteLength(content),
      }],
    });
    const snippet = result.matches[0]?.snippet ?? "";
    expect(snippet).not.toContain("�");
    expect(Buffer.byteLength(snippet)).toBeLessThanOrEqual(1_024);
    expect(snippet.endsWith("😀")).toBe(true);
  });

  test("maps managed binary resolution failures to bounded tool output errors", async () => {
    const runner = new RipgrepArtifactSearchRunner({
      binaryResolver: { resolve: async () => { throw new Error("private path"); } },
    });
    await expect(runner.search(baseSearch("needle"))).rejects.toMatchObject({
      code: "TOOL_OUTPUT_UNAVAILABLE",
    });
  });

  test("maps ripgrep's invalid-pattern exit without exposing process diagnostics", async () => {
    const { runner } = createRunner("", 2);
    await expect(runner.search(baseSearch("["))).rejects.toMatchObject({
      code: "TOOL_OUTPUT_INVALID_PATTERN",
    });
  });

  test("does not resolve a managed binary when there are no artifact segments", async () => {
    let resolveCalls = 0;
    const runner = new RipgrepArtifactSearchRunner({
      binaryResolver: {
        resolve: async () => {
          resolveCalls += 1;
          return "/managed/bin/rg";
        },
      },
    });
    await expect(runner.search({
      ...baseSearch("needle"),
      segments: [],
    })).resolves.toEqual({ matches: [] });
    expect(resolveCalls).toBe(0);
  });
});
