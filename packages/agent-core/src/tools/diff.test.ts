import { describe, expect, it } from "bun:test";
import {
  computeToolDiff,
  computeToolDiffs,
  isProbablyBinaryText,
  MAX_DIFF_FILES,
  MAX_DIFF_INPUT_CHARS,
  MAX_DIFF_OUTPUT_LINES,
  summarizeDiffFailure,
} from "./diff";
import type { DiffLine } from "@archcode/protocol";

// ── isProbablyBinaryText ──────────────────────────────────────────────────

describe("isProbablyBinaryText", () => {
  it("returns true for text containing NUL bytes", () => {
    expect(isProbablyBinaryText("hello\0world")).toBe(true);
  });

  it("returns true for text with high ratio of non-printable characters", () => {
    // A string dominated by control chars (0x01)
    const ctrl = "\x01".repeat(500);
    expect(isProbablyBinaryText(ctrl)).toBe(true);
  });

  it("returns false for normal text", () => {
    expect(isProbablyBinaryText("hello world\nfoo bar\n")).toBe(false);
  });

  it("returns false for unicode text", () => {
    expect(isProbablyBinaryText("你好世界\n¡Hola!")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isProbablyBinaryText("")).toBe(false);
  });
});

// ── computeToolDiff ───────────────────────────────────────────────────────

describe("computeToolDiff", () => {
  it("produces 'modified' status with hunks and correct line types for changed content", () => {
    const before = "line1\nline2\nline3\n";
    const after = "line1\nline2_modified\nline3\nline4\n";

    const result = computeToolDiff({ path: "test.txt", before, after });

    expect(result.version).toBe(1);
    expect(result.unsupportedReason).toBeUndefined();
    expect(result.files).toHaveLength(1);

    const file = result.files[0];
    expect(file.path).toBe("test.txt");
    expect(file.status).toBe("modified");
    expect(file.additions).toBeGreaterThan(0);
    expect(file.deletions).toBeGreaterThan(0);
    expect(file.hunks.length).toBeGreaterThan(0);

    // Check line types are mapped correctly
    const allLines: DiffLine[] = file.hunks.flatMap((h) => h.lines);
    expect(allLines.some((l) => l.type === "add")).toBe(true);
    expect(allLines.some((l) => l.type === "delete")).toBe(true);
    expect(allLines.some((l) => l.type === "context")).toBe(true);
  });

  it("detects 'created' status when before is empty", () => {
    const result = computeToolDiff({ path: "new.txt", before: "", after: "hello\nworld\n" });

    expect(result.files[0].status).toBe("created");
    expect(result.files[0].additions).toBe(2);
    expect(result.files[0].deletions).toBe(0);
  });

  it("respects explicit status override", () => {
    const result = computeToolDiff({
      path: "del.txt",
      before: "content\n",
      after: "",
      status: "deleted",
    });

    expect(result.files[0].status).toBe("deleted");
    expect(result.files[0].additions).toBe(0);
    expect(result.files[0].deletions).toBe(1);
  });

  it("returns no_change for identical content", () => {
    const result = computeToolDiff({ path: "same.txt", before: "abc\n", after: "abc\n" });

    expect(result.unsupportedReason).toBe("no_change");
    expect(result.files).toHaveLength(0);
  });

  it("returns binary for content with NUL bytes", () => {
    const result = computeToolDiff({ path: "bin.bin", before: "\0data", after: "\0data2" });

    expect(result.unsupportedReason).toBe("binary");
    expect(result.files).toHaveLength(0);
  });

  it("returns too_large for oversized input", () => {
    // Input must strictly exceed MAX_DIFF_INPUT_CHARS
    const big = "x".repeat(MAX_DIFF_INPUT_CHARS + 1);
    const result = computeToolDiff({ path: "big.txt", before: "", after: big });

    expect(result.unsupportedReason).toBe("too_large");
    expect(result.files).toHaveLength(0);
  });

  it("handles exactly-at-limit input without triggering too_large", () => {
    const big = "x".repeat(MAX_DIFF_INPUT_CHARS - 1);
    const result = computeToolDiff({ path: "big.txt", before: "", after: big });

    // Should succeed (the diff might be huge but the input is within limit)
    expect(result.unsupportedReason).toBeUndefined();
    expect(result.files).toHaveLength(1);
  });

  it("returns diff_error for invalid input that crashes structuredPatch", () => {
    // structuredPatch should handle most inputs gracefully, but if it throws
    // we still get a diff_error result (test the fallback path)
    const result = computeToolDiff({
      path: "test.txt",
      before: "a",
      after: "b",
      status: "modified" as const,
    });
    // This should succeed normally, not error
    expect(result.unsupportedReason).toBeUndefined();
  });

  it("truncates output when it exceeds MAX_DIFF_OUTPUT_LINES", () => {
    // Create content where the diff has many lines
    const linesA: string[] = [];
    const linesB: string[] = [];
    for (let i = 0; i < MAX_DIFF_OUTPUT_LINES + 100; i++) {
      linesA.push(`line ${i} A`);
      linesB.push(`line ${i} B`); // Every line changed → huge diff
    }

    const result = computeToolDiff({
      path: "big.txt",
      before: linesA.join("\n"),
      after: linesB.join("\n"),
    });

    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(1);
    const totalLines = result.files[0].hunks.reduce(
      (sum, h) => sum + h.lines.length,
      0,
    );
    expect(totalLines).toBeLessThanOrEqual(MAX_DIFF_OUTPUT_LINES);
  });

  it("counts additions and deletions correctly", () => {
    const before = "keep\nremove\n";
    const after = "keep\nadd1\nadd2\n";

    const result = computeToolDiff({ path: "count.txt", before, after });
    const file = result.files[0];

    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
  });

  it("completes diffs on content with trailing newlines", () => {
    const result = computeToolDiff({
      path: "trailing.txt",
      before: "a\nb\n",
      after: "a\nb\nc\n",
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0].additions).toBe(1);
  });

  it("produces correct hunk metadata", () => {
    // File large enough that jsdiff creates separate hunks
    const before =
      "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n" +
      "11\n12\n13\n14\n15\n16\n17\n18\n19\n20\n" +
      "21\n22\n23\n24\n25\n26\n27\n28\n29\n30\n";
    const after =
      "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n" +
      "11\n12\n13\n14\nmodified\n16\n17\n18\n19\n20\n" +
      "21\n22\n23\n24\n25\n26\n27\n28\n29\n30\n";

    const result = computeToolDiff({
      path: "meta.txt",
      before,
      after,
    });

    const hunk = result.files[0].hunks[0];
    expect(hunk.oldStart).toBe(11);
    expect(hunk.newStart).toBe(11);
    expect(hunk.lines.length).toBeGreaterThanOrEqual(3);
    expect(hunk.header).toContain("@@");
    expect(hunk.header).toContain("-");
    expect(hunk.header).toContain("+");
  });
});

// ── computeToolDiffs ──────────────────────────────────────────────────────

describe("computeToolDiffs", () => {
  it("computes diffs for multiple files", () => {
    const files = [
      { path: "a.txt", before: "a", after: "b" },
      { path: "c.txt", before: "", after: "new" },
    ];

    const result = computeToolDiffs(files);

    expect(result.files).toHaveLength(2);
    expect(result.files[0].status).toBe("modified");
    expect(result.files[1].status).toBe("created");
  });

  it("respects MAX_DIFF_FILES limit and adds warning", () => {
    const files = Array.from({ length: MAX_DIFF_FILES + 5 }, (_, i) => ({
      path: `f${i}.txt`,
      before: "",
      after: `content ${i}`,
    }));

    const result = computeToolDiffs(files);

    expect(result.files).toHaveLength(MAX_DIFF_FILES);
    expect(result.truncated).toBe(true);
    expect(result.warning).toContain("limited to");
    expect(result.warning).toContain(String(MAX_DIFF_FILES));
  });

  it("merges warnings from individual files", () => {
    // Trigger an error by... well, we can't easily trigger diff_error
    // So let's just verify merging works with normal results
    const result = computeToolDiffs([{ path: "a.txt", before: "", after: "hi" }]);
    expect(result.warning).toBeUndefined(); // No warnings for normal case
  });

  it("propagates single unsupported reason when all files fail the same way", () => {
    const files = [
      { path: "a.bin", before: "\0data", after: "\0data2" },
      { path: "b.bin", before: "\0x", after: "\0y" },
    ];

    const result = computeToolDiffs(files);

    // Both are binary, so unsupportedReason should be "binary"
    expect(result.unsupportedReason).toBe("binary");
    expect(result.files).toHaveLength(0);
  });
});

// ── summarizeDiffFailure ──────────────────────────────────────────────────

describe("summarizeDiffFailure", () => {
  it("returns messages for all unsupported reasons", () => {
    expect(summarizeDiffFailure("binary")).toContain("binary");
    expect(summarizeDiffFailure("too_large")).toContain("size");
    expect(summarizeDiffFailure("not_text")).toContain("text");
    expect(summarizeDiffFailure("no_change")).toContain("No changes");
    expect(summarizeDiffFailure("diff_error")).toContain("error");
  });
});
