import { describe, expect, test } from "bun:test";
import { WorktreeEnterInputSchema, worktreeEnterTool } from "./worktree";

describe("worktree Session tool contract", () => {
  test("requires explicit existing worktree paths to be absolute", () => {
    expect(WorktreeEnterInputSchema.safeParse({ path: "../other-worktree" }).success).toBe(false);
    expect(WorktreeEnterInputSchema.safeParse({ path: "/tmp/other-worktree" }).success).toBe(true);
  });

  test("describes omitted paths as create-or-re-enter behavior", () => {
    expect(worktreeEnterTool.description).toContain("create or re-enter");
  });
});
