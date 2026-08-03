import { describe, expect, test } from "bun:test";
import { PROJECT_TODO_CONTENT_EXCERPT_MAX_LENGTH, projectTodoContentExcerpt } from "./project-todos";

describe("projectTodoContentExcerpt", () => {
  test("compacts the beginning of canonical Markdown without inferring a title", () => {
    expect(projectTodoContentExcerpt("\n## Goal\n\nResearch and improve codemap\n\n- Keep evidence"))
      .toBe("Goal Research and improve codemap Keep evidence");
    expect(projectTodoContentExcerpt("- [x] Fix the type\n\tMore   detail"))
      .toBe("Fix the type More detail");
  });

  test("bounds the excerpt and does not invent content", () => {
    expect(projectTodoContentExcerpt("x".repeat(200))).toHaveLength(PROJECT_TODO_CONTENT_EXCERPT_MAX_LENGTH);
    expect(projectTodoContentExcerpt(" \n ")).toBe("");
  });

  test("counts Unicode code points without splitting surrogate pairs", () => {
    const exactLimit = `${"a".repeat(78)}😀b`;
    expect(projectTodoContentExcerpt(exactLimit)).toBe(exactLimit);
    expect(Array.from(projectTodoContentExcerpt(exactLimit))).toHaveLength(PROJECT_TODO_CONTENT_EXCERPT_MAX_LENGTH);

    const truncated = projectTodoContentExcerpt(`${exactLimit}c`);
    expect(truncated).toBe(`${"a".repeat(78)}😀…`);
    expect(Array.from(truncated)).toHaveLength(PROJECT_TODO_CONTENT_EXCERPT_MAX_LENGTH);
  });
});
