import { describe, expect, test } from "bun:test";
import {
  parseRgJsonLine,
  parseRgOutput,
  formatSearchResult,
  buildSearchArgs,
  buildFileListArgs,
  buildCountArgs,
  SearchArgsSchema,
  FileArgsSchema,
} from "./search";

// ─── parseRgJsonLine ───

describe("parseRgJsonLine", () => {
  test("parses a match line correctly", () => {
    const line = JSON.stringify({
      type: "match",
      data: {
        path: { text: "src/foo.ts" },
        lines: { text: "const x = 1\n" },
        line_number: 42,
      },
    });
    const result = parseRgJsonLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("match");
    expect(result!.path).toBe("src/foo.ts");
    expect(result!.lineNumber).toBe(42);
    expect(result!.content).toBe("const x = 1");
  });

  test("returns null for begin type", () => {
    const line = JSON.stringify({
      type: "begin",
      data: { path: { text: "src/foo.ts" } },
    });
    expect(parseRgJsonLine(line)).toBeNull();
  });

  test("returns null for end type", () => {
    const line = JSON.stringify({
      type: "end",
      data: { path: { text: "src/foo.ts" } },
    });
    expect(parseRgJsonLine(line)).toBeNull();
  });

  test("returns null for summary type", () => {
    const line = JSON.stringify({
      type: "summary",
      data: { stats: {} },
    });
    expect(parseRgJsonLine(line)).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(parseRgJsonLine("{not valid json")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseRgJsonLine("")).toBeNull();
  });

  test("trims trailing newline from content", () => {
    const line = JSON.stringify({
      type: "match",
      data: {
        path: { text: "bar.ts" },
        lines: { text: "hello world\r\n" },
        line_number: 1,
      },
    });
    const result = parseRgJsonLine(line);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("hello world");
  });

  test("handles missing path gracefully", () => {
    const line = JSON.stringify({
      type: "match",
      data: {
        lines: { text: "content\n" },
        line_number: 1,
      },
    });
    const result = parseRgJsonLine(line);
    expect(result).not.toBeNull();
    expect(result!.path).toBe("");
  });

  test("handles missing line_number gracefully", () => {
    const line = JSON.stringify({
      type: "match",
      data: {
        path: { text: "f.ts" },
        lines: { text: "content\n" },
      },
    });
    const result = parseRgJsonLine(line);
    expect(result).not.toBeNull();
    expect(result!.lineNumber).toBe(0);
  });
});

// ─── parseRgOutput ───

describe("parseRgOutput", () => {
  const matchLine = (path: string, line: number, content: string) =>
    JSON.stringify({
      type: "match",
      data: {
        path: { text: path },
        lines: { text: content + "\n" },
        line_number: line,
      },
    });

  test("collects matches from rg NDJSON output", () => {
    const output = [
      matchLine("a.ts", 1, "foo"),
      matchLine("b.ts", 2, "bar"),
      matchLine("c.ts", 3, "baz"),
    ].join("\n");

    const result = parseRgOutput(output);
    expect(result.matches).toHaveLength(3);
    expect(result.totalMatches).toBe(3);
    expect(result.truncated).toBe(false);
  });

  test("respects maxResults limit", () => {
    const output = [
      matchLine("a.ts", 1, "one"),
      matchLine("a.ts", 2, "two"),
      matchLine("a.ts", 3, "three"),
      matchLine("a.ts", 4, "four"),
      matchLine("a.ts", 5, "five"),
    ].join("\n");

    const result = parseRgOutput(output, 3);
    expect(result.matches).toHaveLength(3);
    expect(result.totalMatches).toBe(5);
    expect(result.truncated).toBe(true);
  });

  test("sets truncated=false when results equal maxResults", () => {
    const output = [
      matchLine("a.ts", 1, "one"),
      matchLine("a.ts", 2, "two"),
    ].join("\n");

    const result = parseRgOutput(output, 2);
    expect(result.matches).toHaveLength(2);
    expect(result.totalMatches).toBe(2);
    expect(result.truncated).toBe(false);
  });

  test("filters out non-match lines", () => {
    const output = [
      matchLine("a.ts", 1, "found"),
      JSON.stringify({ type: "begin", data: {} }),
      JSON.stringify({ type: "summary", data: { stats: {} } }),
    ].join("\n");

    const result = parseRgOutput(output);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].content).toBe("found");
  });

  test("uses default maxResults of 100", () => {
    const lines = Array.from({ length: 150 }, (_, i) => matchLine("f.ts", i + 1, `line${i}`));
    const output = lines.join("\n");

    const result = parseRgOutput(output);
    expect(result.matches).toHaveLength(100);
    expect(result.totalMatches).toBe(150);
    expect(result.truncated).toBe(true);
  });

  test("handles empty output", () => {
    const result = parseRgOutput("");
    expect(result.matches).toHaveLength(0);
    expect(result.totalMatches).toBe(0);
    expect(result.truncated).toBe(false);
  });
});

// ─── formatSearchResult ───

describe("formatSearchResult", () => {
  test("formats content output correctly (default)", () => {
    const result = {
      matches: [
        { type: "match" as const, path: "src/foo.ts", lineNumber: 42, content: "const x = 1" },
        { type: "match" as const, path: "src/bar.ts", lineNumber: 15, content: "const y = 2" },
      ],
      totalMatches: 2,
      truncated: false,
    };
    expect(formatSearchResult(result, "content")).toBe(
      "src/foo.ts:42:const x = 1\nsrc/bar.ts:15:const y = 2",
    );
  });

  test("formats files_with_matches output", () => {
    const result = {
      matches: [
        { type: "match" as const, path: "src/foo.ts", lineNumber: 42, content: "const x = 1" },
        { type: "match" as const, path: "src/foo.ts", lineNumber: 43, content: "const y = 2" },
        { type: "match" as const, path: "src/bar.ts", lineNumber: 15, content: "const z = 3" },
      ],
      totalMatches: 3,
      truncated: false,
    };
    expect(formatSearchResult(result, "files_with_matches")).toBe("src/bar.ts\nsrc/foo.ts");
  });

  test("formats count output", () => {
    const result = {
      matches: [
        { type: "match" as const, path: "src/foo.ts", lineNumber: 42, content: "a" },
        { type: "match" as const, path: "src/foo.ts", lineNumber: 43, content: "b" },
        { type: "match" as const, path: "src/bar.ts", lineNumber: 15, content: "c" },
        { type: "match" as const, path: "src/bar.ts", lineNumber: 16, content: "d" },
        { type: "match" as const, path: "src/bar.ts", lineNumber: 17, content: "e" },
      ],
      totalMatches: 5,
      truncated: false,
    };
    expect(formatSearchResult(result, "count")).toBe("src/bar.ts:3\nsrc/foo.ts:2");
  });

  test("formats empty result", () => {
    const result = {
      matches: [],
      totalMatches: 0,
      truncated: false,
    };
    expect(formatSearchResult(result, "content")).toBe("");
  });

  test("defaults outputMode to content", () => {
    const result = {
      matches: [
        { type: "match" as const, path: "a.ts", lineNumber: 1, content: "x" },
      ],
      totalMatches: 1,
      truncated: false,
    };
    expect(formatSearchResult(result)).toBe("a.ts:1:x");
  });
});

// ─── buildSearchArgs ───

describe("buildSearchArgs", () => {
  test("constructs basic rg search arguments", () => {
    const args = buildSearchArgs({ pattern: "foo" }, "/usr/bin/rg");
    expect(args).toContain("--json");
    expect(args).toContain("-e");
    expect(args).toContain("foo");
  });

  test("includes path when provided", () => {
    const args = buildSearchArgs({ pattern: "foo", path: "src/" }, "/usr/bin/rg");
    expect(args).toContain("src/");
  });

  test("includes glob filter when provided", () => {
    const args = buildSearchArgs({ pattern: "bar", include: "*.ts" }, "/usr/bin/rg");
    expect(args).toContain("--glob");
    expect(args).toContain("*.ts");
  });

  test("includes context when provided", () => {
    const args = buildSearchArgs({ pattern: "test", context: 3 }, "/usr/bin/rg");
    expect(args).toContain("--context");
    expect(args).toContain("3");
  });

  test("sets max-count to 100", () => {
    const args = buildSearchArgs({ pattern: "foo" }, "/usr/bin/rg");
    const maxCountIdx = args.indexOf("--max-count");
    expect(maxCountIdx).not.toBe(-1);
    expect(args[maxCountIdx + 1]).toBe("100");
  });
});

// ─── buildFileListArgs ───

describe("buildFileListArgs", () => {
  test("constructs --files-with-matches arguments", () => {
    const args = buildFileListArgs("hello");
    expect(args).toEqual(["--files-with-matches", "-e", "hello"]);
  });

  test("includes glob when provided", () => {
    const args = buildFileListArgs("hello", "*.ts");
    expect(args).toContain("--glob");
    expect(args).toContain("*.ts");
  });

  test("includes path when provided", () => {
    const args = buildFileListArgs("hello", undefined, "src/");
    expect(args).toContain("src/");
  });

  test("includes both glob and path", () => {
    const args = buildFileListArgs("hello", "*.ts", "src/");
    expect(args).toEqual(["--files-with-matches", "-e", "hello", "--glob", "*.ts", "src/"]);
  });
});

// ─── buildCountArgs ───

describe("buildCountArgs", () => {
  test("constructs --count arguments", () => {
    const args = buildCountArgs("hello");
    expect(args).toEqual(["--count", "-e", "hello"]);
  });

  test("includes glob when provided", () => {
    const args = buildCountArgs("hello", "*.ts");
    expect(args).toContain("--glob");
    expect(args).toContain("*.ts");
  });

  test("includes path when provided", () => {
    const args = buildCountArgs("hello", undefined, "src/");
    expect(args).toContain("src/");
  });

  test("includes both glob and path", () => {
    const args = buildCountArgs("hello", "*.ts", "src/");
    expect(args).toEqual(["--count", "-e", "hello", "--glob", "*.ts", "src/"]);
  });
});

// ─── Zod Schemas ───

describe("SearchArgsSchema", () => {
  test("validates a valid SearchArgs", () => {
    const result = SearchArgsSchema.parse({
      pattern: "foo",
      path: "src/",
      include: "*.ts",
      outputMode: "content",
      context: 2,
    });
    expect(result.pattern).toBe("foo");
  });

  test("rejects unknown properties", () => {
    expect(() =>
      SearchArgsSchema.parse({
        pattern: "foo",
        unknownField: "bar",
      }),
    ).toThrow();
  });

  test("pattern is required", () => {
    expect(() => SearchArgsSchema.parse({})).toThrow();
    expect(() => SearchArgsSchema.parse({ pattern: "ok" })).not.toThrow();
  });

  test("outputMode defaults to content", () => {
    const result = SearchArgsSchema.parse({ pattern: "foo" });
    expect(result.outputMode).toBe("content");
  });

  test("context defaults to 0", () => {
    const result = SearchArgsSchema.parse({ pattern: "foo" });
    expect(result.context).toBe(0);
  });
});

describe("FileArgsSchema", () => {
  test("validates a valid FileArgs", () => {
    const result = FileArgsSchema.parse({
      pattern: "*.ts",
      path: "src/",
      sortBy: "modified",
    });
    expect(result.pattern).toBe("*.ts");
  });

  test("rejects unknown properties", () => {
    expect(() =>
      FileArgsSchema.parse({
        pattern: "*.ts",
        unknownField: true,
      }),
    ).toThrow();
  });

  test("all fields are optional", () => {
    const result = FileArgsSchema.parse({});
    expect(result).toBeDefined();
  });

  test("sortBy defaults to modified", () => {
    const result = FileArgsSchema.parse({});
    expect(result.sortBy).toBe("modified");
  });
});
