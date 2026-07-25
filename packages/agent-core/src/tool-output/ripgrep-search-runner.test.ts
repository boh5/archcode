import { describe, expect, test } from "bun:test";
import type { ProcessRunnerInput, ProcessRunnerResult } from "../process/types";
import { RipgrepArtifactSearchRunner } from "./ripgrep-search-runner";

function outputCapture() {
  return {
    stdout: "",
    stderr: "",
    combined: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    combinedTruncated: false,
    maxOutputBytes: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    sinkStatus: "complete" as const,
  };
}

function createRunner(stdout: string, exitCode = 0): {
  readonly runner: RipgrepArtifactSearchRunner;
  readonly inputs: ProcessRunnerInput[];
} {
  const inputs: ProcessRunnerInput[] = [];
  const processRunner = {
    async run(input: ProcessRunnerInput): Promise<ProcessRunnerResult> {
      inputs.push(input);
      await input.outputSink?.write("stdout", new TextEncoder().encode(stdout));
      const base = {
        argv: input.argv,
        cwd: input.cwd,
        startedAt: 1,
        finishedAt: 2,
        durationMs: 1,
        output: outputCapture(),
      };
      if (input.signal?.aborted) {
        return { ...base, kind: "aborted", exitCode: null, reason: String(input.signal.reason ?? "aborted") };
      }
      return exitCode === 0
        ? { ...base, kind: "success", exitCode: 0 }
        : { ...base, kind: "nonzero", exitCode };
    },
  };
  return {
    runner: new RipgrepArtifactSearchRunner({
      binaryResolver: { resolve: async () => "/managed/bin/rg" },
      processRunner,
    }),
    inputs,
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
    const { runner, inputs } = createRunner("1:0:needle\n3:17:needle\n");
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
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.argv).toEqual([
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
    expect(inputs[0]?.maxOutputBytes).toBe(0);
    expect(inputs[0]?.outputSink).toBeDefined();
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

  test("maps ProcessRunner timeout to the bounded search timeout", async () => {
    const runner = new RipgrepArtifactSearchRunner({
      binaryResolver: { resolve: async () => "/managed/bin/rg" },
      processRunner: {
        async run(input) {
          return {
            kind: "timeout",
            argv: input.argv,
            cwd: input.cwd,
            startedAt: 1,
            finishedAt: 2,
            durationMs: 1,
            timeoutMs: input.timeoutMs ?? 1,
            exitCode: null,
            output: outputCapture(),
          };
        },
      },
    });
    await expect(runner.search(baseSearch("needle"))).rejects.toMatchObject({
      code: "TOOL_OUTPUT_SEARCH_TIMEOUT",
    });
  });

  test("ignores output delivered after a page boundary abort", async () => {
    const runner = new RipgrepArtifactSearchRunner({
      binaryResolver: { resolve: async () => "/managed/bin/rg" },
      processRunner: {
        async run(input) {
          await input.outputSink?.write("stdout", new TextEncoder().encode("1:0:first\n2:6:second\n"));
          await input.outputSink?.write("stdout", new TextEncoder().encode("partial garbage after abort"));
          return {
            kind: "aborted",
            argv: input.argv,
            cwd: input.cwd,
            startedAt: 1,
            finishedAt: 2,
            durationMs: 1,
            exitCode: null,
            output: outputCapture(),
          };
        },
      },
    });

    const result = await runner.search(baseSearch("first|second"));

    expect(result.matches.map((match) => match.snippet)).toEqual(["first"]);
    expect(result.nextCursor).toBeDefined();
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
