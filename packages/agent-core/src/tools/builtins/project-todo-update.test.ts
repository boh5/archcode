import { describe, expect, mock, test } from "bun:test";
import { TOOL_PROJECT_TODO_UPDATE } from "@archcode/protocol";
import { z } from "zod/v4";

import { createMockStore } from "../../store/test-helpers";
import { storeManager } from "../../store/store";
import type { SessionStoreState } from "../../store/types";
import { expectTextDraft } from "../test-results";
import { createToolExecutionContext, type ToolExecutionContext } from "../types";
import { ProjectTodoUpdateInputSchema, projectTodoUpdateTool } from "./project-todo-update";

const sessionId = "22222222-2222-4222-8222-222222222222";
const input = {
  expectedRevision: 4,
  patch: {
    title: "Clarified intent",
    body: "Outcome and constraints confirmed.",
    decision: {
      action: "mark_ready" as const,
      rationale: "The user explicitly confirmed this Todo is ready.",
    },
  },
};

function makeContext(
  overrides: Partial<SessionStoreState> = {},
  updateFromDiscussion = mock(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    title: input.patch.title,
    body: input.patch.body,
    status: "ready" as const,
    revision: 5,
  })),
): { ctx: ToolExecutionContext; updateFromDiscussion: typeof updateFromDiscussion } {
  const store = createMockStore({
    sessionId,
    rootSessionId: sessionId,
    agentName: "shaper",
    ...overrides,
  });
  const projectContext = {
    project: { slug: "test-project" },
    todos: { updateFromDiscussion },
  } as unknown as ToolExecutionContext["projectContext"];

  return {
    updateFromDiscussion,
    ctx: createToolExecutionContext({
      store,
      storeManager,
      toolName: TOOL_PROJECT_TODO_UPDATE,
      toolCallId: "project-todo-update-call",
      input,
      step: 1,
      abort: new AbortController().signal,
      agentName: store.getState().agentName,
      startedAt: Date.now(),
      allowedTools: new Set([TOOL_PROJECT_TODO_UPDATE]),
      projectContext,
      cwd: "/tmp/project",
    }),
  };
}

describe("project_todo_update", () => {
  test("accepts only the discussion-owned mutable fields and no Todo identity", () => {
    expect(ProjectTodoUpdateInputSchema.safeParse(input).success).toBe(true);
    expect(ProjectTodoUpdateInputSchema.safeParse({
      expectedRevision: 4,
      patch: {
        body: "One material question remains.",
        decision: { action: "keep_current", rationale: "The current status remains correct." },
      },
    }).success).toBe(true);
    expect(ProjectTodoUpdateInputSchema.safeParse({
      expectedRevision: 4,
      patch: {
        decision: { action: "reject", rationale: "No longer aligned" },
      },
    }).success).toBe(true);
    expect(ProjectTodoUpdateInputSchema.safeParse({ ...input, todoId: crypto.randomUUID() }).success).toBe(false);
    expect(ProjectTodoUpdateInputSchema.safeParse({
      expectedRevision: 4,
      patch: { decision: { action: "mark_done", rationale: "Finished" } },
    }).success).toBe(false);
    expect(ProjectTodoUpdateInputSchema.safeParse({
      expectedRevision: 4,
      patch: {
        decision: { action: "mark_idea", rationale: "Still unresolved" },
        rejectionReason: "Not applicable",
      },
    }).success).toBe(false);
    expect(ProjectTodoUpdateInputSchema.safeParse({
      expectedRevision: 4,
      patch: {
        status: "idea",
        decision: { action: "mark_idea", rationale: "Still unresolved" },
      },
    }).success).toBe(false);
    expect(ProjectTodoUpdateInputSchema.safeParse({
      expectedRevision: 4,
      patch: {
        reject: { reason: "Not aligned" },
        decision: { action: "reject", rationale: "Not aligned" },
      },
    }).success).toBe(false);
    expect(ProjectTodoUpdateInputSchema.safeParse({
      ...input,
      patch: { ...input.patch, archivedAt: Date.now() },
    }).success).toBe(false);
    expect(ProjectTodoUpdateInputSchema.safeParse({
      ...input,
      patch: { ...input.patch, activation: {} },
    }).success).toBe(false);
    expect(ProjectTodoUpdateInputSchema.safeParse({ expectedRevision: 4, patch: {} }).success).toBe(false);
    expect(ProjectTodoUpdateInputSchema.safeParse({
      expectedRevision: 4,
      patch: { decision: { action: "mark_ready", rationale: "" } },
    }).success).toBe(false);
    expect(ProjectTodoUpdateInputSchema.safeParse({
      expectedRevision: 4,
      patch: { decision: { action: "keep_current", rationale: "No change" } },
    }).success).toBe(false);
    expect(ProjectTodoUpdateInputSchema.safeParse({ ...input, expectedRevision: 0 }).success).toBe(false);
    expect(ProjectTodoUpdateInputSchema.safeParse({ ...input, expectedRevision: -1 }).success).toBe(false);
  });

  test("exposes one flat decision schema without provider branch selection", () => {
    const jsonSchema = JSON.stringify(z.toJSONSchema(ProjectTodoUpdateInputSchema));

    expect(jsonSchema).not.toContain("anyOf");
    expect(jsonSchema).toContain("keep_current");
    expect(jsonSchema).toContain("mark_ready");
  });

  test("derives the Todo binding authorization from the current root Shaper Session", async () => {
    const { ctx, updateFromDiscussion } = makeContext();

    const result = await projectTodoUpdateTool.execute(input, ctx);

    expect(result.isError).toBe(false);
    expect(updateFromDiscussion).toHaveBeenCalledWith({
      authorization: {
        sessionId,
        rootSessionId: sessionId,
        agentName: "shaper",
        projectSlug: "test-project",
      },
      expectedRevision: 4,
      patch: {
        title: "Clarified intent",
        body: "Outcome and constraints confirmed.",
        status: "ready",
      },
    });
    expect(JSON.parse(expectTextDraft(result))).toMatchObject({ revision: 5, status: "ready" });
  });

  test("maps Idea without leaking its rationale into the rejection reason", async () => {
    const ideaInput = {
      expectedRevision: 4,
      patch: {
        body: "One question remains.",
        decision: {
          action: "mark_idea" as const,
          rationale: "The interaction surface is unresolved.",
        },
      },
    };
    const { ctx, updateFromDiscussion } = makeContext();

    await projectTodoUpdateTool.execute(ideaInput, ctx);

    expect(updateFromDiscussion).toHaveBeenCalledWith(expect.objectContaining({
      patch: {
        body: "One question remains.",
        status: "idea",
      },
    }));
  });

  test("keeps the current status and rejection reason on content-only corrections", async () => {
    const keepInput = {
      expectedRevision: 4,
      patch: {
        title: "Corrected wording",
        decision: {
          action: "keep_current" as const,
          rationale: "The wording changed, not the confirmed status.",
        },
      },
    };
    const { ctx, updateFromDiscussion } = makeContext();

    await projectTodoUpdateTool.execute(keepInput, ctx);

    expect(updateFromDiscussion).toHaveBeenCalledWith(expect.objectContaining({
      patch: { title: "Corrected wording" },
    }));
  });

  test("maps the explicit reject action to the domain rejection fields", async () => {
    const rejectInput = {
      expectedRevision: 4,
      patch: {
        title: "Rejected intent",
        decision: {
          action: "reject" as const,
          rationale: "No longer aligned",
        },
      },
    };
    const { ctx, updateFromDiscussion } = makeContext();

    await projectTodoUpdateTool.execute(rejectInput, ctx);

    expect(updateFromDiscussion).toHaveBeenCalledWith({
      authorization: {
        sessionId,
        rootSessionId: sessionId,
        agentName: "shaper",
        projectSlug: "test-project",
      },
      expectedRevision: 4,
      patch: {
        title: "Rejected intent",
        status: "rejected",
        rejectionReason: "No longer aligned",
      },
    });
  });

  test("rejects non-Shaper and child Sessions before reaching the Todo service", async () => {
    for (const overrides of [
      { agentName: "engineer" as const },
      { rootSessionId: crypto.randomUUID() },
      { parentSessionId: crypto.randomUUID() },
    ]) {
      const { ctx, updateFromDiscussion } = makeContext(overrides);

      const result = await projectTodoUpdateTool.execute(input, ctx);

      expect(result.isError).toBe(true);
      expect(expectTextDraft(result)).toContain("PROJECT_TODO_UPDATE_DENIED");
      expect(updateFromDiscussion).not.toHaveBeenCalled();
    }
  });

  test("returns binding, project, and revision failures as tool errors", async () => {
    const { ctx } = makeContext({}, mock(async () => {
      throw new Error("Project Todo discussion binding not found");
    }));

    const result = await projectTodoUpdateTool.execute(input, ctx);

    expect(result.isError).toBe(true);
    expect(expectTextDraft(result)).toContain("Project Todo discussion binding not found");
  });
});
