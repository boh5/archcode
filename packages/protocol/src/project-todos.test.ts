import { describe, expect, test } from "bun:test";
import { PROJECT_TODO_DISPLAY_LABEL_MAX_LENGTH, projectTodoDisplayLabel } from "./project-todos";

describe("projectTodoDisplayLabel", () => {
  test("derives one stable display label from canonical Markdown", () => {
    expect(projectTodoDisplayLabel("\n## Ship offline mode\n\nAcceptance details", "todo-1"))
      .toBe("Ship offline mode");
    expect(projectTodoDisplayLabel("- [x] Fix the type\nMore detail"))
      .toBe("Fix the type");
  });

  test("bounds the projection and uses the Todo id only for empty defensive input", () => {
    expect(projectTodoDisplayLabel("x".repeat(200))).toHaveLength(PROJECT_TODO_DISPLAY_LABEL_MAX_LENGTH);
    expect(projectTodoDisplayLabel(" \n ", "12345678-rest")).toBe("Todo 12345678");
  });
});
