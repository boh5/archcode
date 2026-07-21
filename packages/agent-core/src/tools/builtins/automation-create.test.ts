import { describe, expect, mock, test } from "bun:test";
import { TOOL_AUTOMATION_CREATE, type Automation } from "@archcode/protocol";

import { createMockStore } from "../../store/test-helpers";
import { storeManager } from "../../store/store";
import type { SessionStoreState } from "../../store/types";
import { expectTextDraft } from "../test-results";
import { createToolExecutionContext, type ToolExecutionContext } from "../types";
import { AutomationCreateSchema } from "../../automations/schema";
import { automationCreateTool } from "./automation-create";

const input = {
  name: "Daily review",
  trigger: { kind: "cron" as const, expression: "0 9 * * *", timezone: "Asia/Shanghai" },
  action: { kind: "start_session" as const, message: "Review the project", location: "project" as const },
};

function makeAutomation(createdFromSessionId: string): Automation {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectSlug: "test-project",
    createdFromSessionId,
    ...input,
    status: "active",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

function makeContext(
  overrides: Partial<SessionStoreState> = {},
  createAutomation = mock(async (creation: { createdFromSessionId: string }) => makeAutomation(creation.createdFromSessionId)),
): { ctx: ToolExecutionContext; createAutomation: typeof createAutomation } {
  const store = createMockStore({
    sessionId: "22222222-2222-4222-8222-222222222222",
    rootSessionId: "22222222-2222-4222-8222-222222222222",
    agentName: "lead",
    ...overrides,
  });
  const projectContext = {
    createAutomation,
    todos: {
      state: {
        findByDiscussionSessionId: mock(async () => undefined),
      },
    },
  } as unknown as ToolExecutionContext["projectContext"];
  return {
    createAutomation,
    ctx: createToolExecutionContext({
      store,
      storeManager,
      toolName: TOOL_AUTOMATION_CREATE,
      toolCallId: "automation-create-call",
      input,
      step: 1,
      abort: new AbortController().signal,
      agentName: store.getState().agentName,
      startedAt: Date.now(),
      allowedTools: new Set([TOOL_AUTOMATION_CREATE]),
      projectContext,
      cwd: "/tmp/project",
    }),
  };
}

describe("automation_create", () => {
  test("model input is strict and excludes provenance", () => {
    expect(AutomationCreateSchema.safeParse(input).success).toBe(true);
    expect(AutomationCreateSchema.safeParse({ ...input, createdFromSessionId: crypto.randomUUID() }).success).toBe(false);
    expect(AutomationCreateSchema.safeParse({ ...input, status: "active" }).success).toBe(false);
  });

  test("derives provenance from an ordinary Lead root Session", async () => {
    const { ctx, createAutomation } = makeContext();

    const result = await automationCreateTool.execute(input, ctx);

    expect(result.isError).toBe(false);
    expect(createAutomation).toHaveBeenCalledWith({
      ...input,
      createdFromSessionId: "22222222-2222-4222-8222-222222222222",
    });
  });

  test("rejects child and non-Lead Sessions", async () => {
    for (const override of [
      { rootSessionId: crypto.randomUUID() },
      { parentSessionId: crypto.randomUUID() },
      { agentName: "explore" as const },
    ]) {
      const { ctx, createAutomation } = makeContext(override);
      const result = await automationCreateTool.execute(input, ctx);

      expect(result.isError).toBe(true);
      expect(expectTextDraft(result)).toContain("AUTOMATION_CREATE_DENIED");
      expect(createAutomation).not.toHaveBeenCalled();
    }
  });
});
