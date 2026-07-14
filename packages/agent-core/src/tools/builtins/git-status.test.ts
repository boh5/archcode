import { describe, expect, test } from "bun:test";
import { parseGitStatusOutput } from "./git-status";

describe("parseGitStatusOutput", () => {
  test("parses NUL-delimited porcelain output", () => {
    const raw = "M  src/foo.ts\0A  bar.ts\0?? untracked.ts\0";
    expect(parseGitStatusOutput(raw)).toBe("M  src/foo.ts\nA  bar.ts\n?? untracked.ts");
  });

  test("handles empty output (clean working tree)", () => {
    expect(parseGitStatusOutput("")).toBe("");
  });

  test("handles single entry without trailing NUL", () => {
    expect(parseGitStatusOutput("M  file.ts")).toBe("M  file.ts");
  });

  test("handles only NUL characters", () => {
    expect(parseGitStatusOutput("\0\0\0")).toBe("");
  });

  test("preserves all status prefix variants", () => {
    const raw =
      " M staged.ts\0MM both.ts\0A  added.ts\0 D deleted.ts\0?? untracked.ts\0" +
      "R  renamed.ts\0C  copied.ts\0U unmerged.ts";
    expect(parseGitStatusOutput(raw)).toBe(
      " M staged.ts\nMM both.ts\nA  added.ts\n D deleted.ts\n?? untracked.ts\n" +
      "R  renamed.ts\nC  copied.ts\nU unmerged.ts",
    );
  });
});
