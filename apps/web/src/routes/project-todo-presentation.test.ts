import { describe, expect, test } from "bun:test";
import { PROJECT_TODO_LANE_PRESENTATIONS, presentProjectTodoCard } from "./project-todo-presentation";

describe("Project Todo presentation", () => {
  test("presents only canonical Todo status and archive facts", () => {
    expect(presentProjectTodoCard({ status: "in_progress" })).toMatchObject({ label: "In Progress", tone: "signal" });
    expect(presentProjectTodoCard({ status: "done", archivedAt: 1 })).toMatchObject({ label: "Archived" });
  });

  test("keeps four explicit board lanes in product order", () => {
    expect(Object.keys(PROJECT_TODO_LANE_PRESENTATIONS)).toEqual(["idea", "ready", "in_progress", "done"]);
  });
});
