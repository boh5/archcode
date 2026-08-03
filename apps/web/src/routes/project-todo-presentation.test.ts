import { describe, expect, test } from "bun:test";
import {
  PROJECT_TODO_LANE_PRESENTATIONS,
  demoteEmbeddedMarkdownHeadings,
  presentProjectTodoCard,
  projectTodoContentPreview,
  projectTodoContentRemainder,
} from "./project-todo-presentation";

describe("Project Todo presentation", () => {
  test("presents only canonical Todo status and archive facts", () => {
    expect(presentProjectTodoCard({ status: "in_progress" })).toMatchObject({ label: "In Progress", tone: "signal" });
    expect(presentProjectTodoCard({ status: "done", archivedAt: 1 })).toMatchObject({ label: "Archived" });
  });

  test("keeps four explicit board lanes in product order", () => {
    expect(Object.keys(PROJECT_TODO_LANE_PRESENTATIONS)).toEqual(["idea", "ready", "in_progress", "done"]);
  });

  test("projects one canonical Markdown document without repeating its display label", () => {
    const content = "\n# Add semantic search\n\n## Problem\nDevelopers lose context.\n\n- Search files\n- Keep stable links";
    expect(projectTodoContentRemainder(content)).toBe("## Problem\nDevelopers lose context.\n\n- Search files\n- Keep stable links");
    expect(projectTodoContentPreview(content)).toBe("Problem Developers lose context. Search files Keep stable links");
    expect(projectTodoContentRemainder("One-line capture")).toBe("");
  });

  test("keeps embedded Markdown headings below the detail route heading", () => {
    expect(demoteEmbeddedMarkdownHeadings("# Plan\n\n## Step\n\n```md\n# example\n```"))
      .toBe("## Plan\n\n### Step\n\n```md\n# example\n```");
  });

  test("requires a matching fence length before demoting later headings", () => {
    expect(demoteEmbeddedMarkdownHeadings("````md\n# example\n```\n# still example\n````\n# Outside"))
      .toBe("````md\n# example\n```\n# still example\n````\n## Outside");
  });
});
