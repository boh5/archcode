import { describe, expect, test } from "bun:test";
import type { ProjectSessionInventoryItem } from "../api/types";
import {
  PROJECT_TODO_LANE_PRESENTATIONS,
  demoteEmbeddedMarkdownHeadings,
  presentProjectTodoLinkedSession,
  presentProjectTodoCard,
  projectTodoDisplayLead,
  projectTodoPreviewExcerpt,
} from "./project-todo-presentation";

describe("Project Todo presentation", () => {
  test("presents only canonical Todo status and archive facts", () => {
    expect(presentProjectTodoCard({ status: "in_progress" })).toMatchObject({ label: "In Progress", tone: "signal" });
    expect(presentProjectTodoCard({ status: "done", archivedAt: 1 })).toMatchObject({ label: "Archived" });
  });

  test("keeps four explicit board lanes in product order", () => {
    expect(Object.keys(PROJECT_TODO_LANE_PRESENTATIONS)).toEqual(["idea", "ready", "in_progress", "done"]);
  });

  test("derives the prototype display lead without creating a Todo title", () => {
    expect(projectTodoDisplayLead("Intro\n\n# Visible lead\n\nBody stays canonical")).toBe("Visible lead");
    expect(projectTodoDisplayLead("- [x] First line\nMore detail")).toBe("First line More detail");
    expect(Array.from(projectTodoDisplayLead("界".repeat(90)))).toHaveLength(80);
  });

  test("renders the prototype preview body as bounded plain text below the lead", () => {
    expect(projectTodoPreviewExcerpt("# Visible lead\n\n## Context\n- Keep **canonical** data"))
      .toBe("Context Keep canonical data");
    expect(Array.from(projectTodoPreviewExcerpt("界".repeat(190)))).toHaveLength(180);
  });

  test("keeps embedded Markdown hierarchy below its owning detail section", () => {
    expect(demoteEmbeddedMarkdownHeadings("# Plan\n\n## Step\n\n##### Limit\n\n```md\n# example\n```"))
      .toBe("### Plan\n\n#### Step\n\n###### Limit\n\n```md\n# example\n```");
  });

  test("requires a matching fence length before demoting later headings", () => {
    expect(demoteEmbeddedMarkdownHeadings("````md\n# example\n```\n# still example\n````\n# Outside"))
      .toBe("````md\n# example\n```\n# still example\n````\n### Outside");
  });

  test("presents linked Session context with canonical status glyph semantics", () => {
    const item = {
      session: {
        sessionId: "session-1",
        agentName: "lead",
        source: { kind: "todo", todoId: "todo-1", entry: "work" },
      },
      latestExecution: { status: "completed" },
    } as ProjectSessionInventoryItem;

    expect(presentProjectTodoLinkedSession(item)).toEqual({
      context: "Lead · execution attached to this Todo",
      kind: "completed",
      label: "Done",
    });
    expect(presentProjectTodoLinkedSession({
      ...item,
      latestExecution: { status: "running" },
    } as ProjectSessionInventoryItem)).toMatchObject({ kind: "running", label: "Running" });
  });
});
