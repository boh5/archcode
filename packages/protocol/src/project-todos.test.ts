import { describe, expect, test } from "bun:test";
import type { RootSessionSummary } from "./types";
import type { ProjectTodoStartDiscussionResponse } from "./workbench";
import {
  PROJECT_TODO_CONTENT_EXCERPT_MAX_LENGTH,
  projectTodoContentExcerpt,
  type ProjectTodoStartDiscussionInput,
  type ProjectTodoStartDiscussionReceipt,
} from "./project-todos";

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

describe("Project Todo Start discussion wire contract", () => {
  test("carries one stable request identity and exact retained Todo and Session ids", () => {
    const clientRequestId = crypto.randomUUID();
    const todoId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const input: ProjectTodoStartDiscussionInput = {
      clientRequestId,
      content: "Discuss the captured idea",
    };
    const receipt: ProjectTodoStartDiscussionReceipt = {
      clientRequestId,
      requestHash: "a".repeat(64),
      todoId,
      sessionId,
      status: "recovery_required",
    };
    const session = {
      sessionId,
      rootSessionId: sessionId,
      cwd: "/project",
      agentName: "discussion",
      profile: "principal",
      title: "Discussion: Discuss the captured idea",
      activeSkillNames: [],
      modelSelection: { revision: 0 },
      source: { kind: "todo", todoId, entry: "discussion" },
      createdAt: 1,
      updatedAt: 1,
    } satisfies RootSessionSummary;
    const response: ProjectTodoStartDiscussionResponse = {
      todo: {
        id: todoId,
        content: input.content,
        attachmentIds: [],
        status: "idea",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      session,
    };

    expect(receipt).toMatchObject({ clientRequestId, todoId, sessionId });
    expect(response).toMatchObject({
      todo: { id: todoId },
      session: { sessionId, source: { kind: "todo", todoId, entry: "discussion" } },
    });
  });
});
