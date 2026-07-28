import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  Automation,
  Project,
  SessionSummaryWithGoal,
  SessionTreeResponse,
} from "../../api/types";

interface ElementLike {
  type?: unknown;
  props?: Record<string, unknown> | null;
}

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (typeof value !== "object" || value === null || !("props" in value)) return "";
  return textContent((value as ElementLike).props?.children);
}

const deleteSessionMutate = mock(
  (_input: unknown, _options?: { onSuccess?: () => void }) => {},
);
const deleteAutomationMutate = mock(
  (_input: unknown, _options?: { onSuccess?: () => void }) => {},
);
let sessionTree: {
  data: SessionTreeResponse | undefined;
  error: Error | null;
  isLoading: boolean;
};

mock.module("../../api/mutations", () => ({
  useDeleteSession: () => ({
    mutate: deleteSessionMutate,
    error: null,
    isPending: false,
  }),
  useDeleteAutomation: () => ({
    mutate: deleteAutomationMutate,
    error: null,
    isPending: false,
  }),
}));

mock.module("../../api/queries", () => ({
  useSessionTree: () => sessionTree,
}));

mock.module("./DestructiveActionDialog", () => ({
  DestructiveActionDialog: "DestructiveActionDialog",
}));

const { DeleteSessionDialog } = await import("./DeleteSessionDialog");
const { DeleteAutomationDialog } = await import("./DeleteAutomationDialog");

const project: Project = {
  slug: "demo",
  name: "Demo",
  workspaceRoot: "/workspace/demo",
  addedAt: "2026-07-28T00:00:00.000Z",
};

const rootSession = session("root-session", null, "/workspace/demo/.archcode/worktrees/root");
const childSession = session("child-session", "Explore implementation", rootSession.cwd, "root-session");
const automation: Automation = {
  id: "automation-1",
  projectSlug: "demo",
  createdFromSessionId: "source-session",
  name: "Continue review",
  trigger: { kind: "interval", everyMs: 60_000 },
  action: {
    kind: "send_message",
    sessionId: "child-session",
    message: "Continue",
  },
  status: "active",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

describe("resource deletion dialogs", () => {
  beforeEach(() => {
    deleteSessionMutate.mockClear();
    deleteAutomationMutate.mockClear();
    sessionTree = {
      data: {
        root: {
          session: rootSession,
          children: [{ session: childSession, children: [] }],
        },
        diagnostics: [],
      },
      error: null,
      isLoading: false,
    };
  });

  test("blocks Session deletion while an Automation targets the family", () => {
    const element = DeleteSessionDialog({
      automations: [automation],
      open: true,
      project,
      session: rootSession,
      onClose: () => {},
      onDeleted: () => {},
    }) as ElementLike;

    expect(element.props?.blocked).toBe(true);
    expect(textContent(element.props?.blockedMessage)).toContain("Continue review");
    expect(textContent(element.props?.note)).toContain("working directory will be preserved");
    expect(element.props?.consequences).toContain(
      "Conversation history, Goal, and 1 delegated Agent Session",
    );
  });

  test("deletes the complete inspected Session family", () => {
    deleteSessionMutate.mockImplementation((_input, options) => options?.onSuccess?.());
    const onDeleted = mock((_session: SessionSummaryWithGoal) => {});
    const element = DeleteSessionDialog({
      automations: [],
      open: true,
      project,
      session: rootSession,
      onClose: () => {},
      onDeleted,
    }) as ElementLike;

    (element.props?.onConfirm as () => void)();

    expect(deleteSessionMutate.mock.calls[0]?.[0]).toEqual({
      slug: "demo",
      sessionId: "root-session",
      rootSessionId: "root-session",
      sessionIds: ["root-session", "child-session"],
    });
    expect(onDeleted).toHaveBeenCalledWith(rootSession);
  });

  test("keeps Session deletion disabled when family inspection fails", () => {
    sessionTree = {
      data: undefined,
      error: new Error("tree unavailable"),
      isLoading: false,
    };
    const element = DeleteSessionDialog({
      automations: [],
      open: true,
      project,
      session: rootSession,
      onClose: () => {},
      onDeleted: () => {},
    }) as ElementLike;

    expect(element.props?.blocked).toBe(true);
    expect(element.props?.error).toContain("tree unavailable");
  });

  test("requires Automation confirmation and explains preserved Sessions", () => {
    deleteAutomationMutate.mockImplementation((_input, options) => options?.onSuccess?.());
    const onDeleted = mock(() => {});
    const element = DeleteAutomationDialog({
      automation,
      open: true,
      slug: "demo",
      onClose: () => {},
      onDeleted,
    }) as ElementLike;

    expect(element.props?.title).toBe("Delete Automation?");
    expect(element.props?.consequences).toContain(
      "Pending runs and the complete invocation history",
    );
    expect(textContent(element.props?.note)).toContain(
      "Sessions already created or updated by this Automation will remain unchanged",
    );

    (element.props?.onConfirm as () => void)();
    expect(deleteAutomationMutate.mock.calls[0]?.[0]).toEqual({
      slug: "demo",
      automationId: "automation-1",
    });
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });
});

function session(
  sessionId: string,
  title: string | null,
  cwd: string,
  rootSessionId = sessionId,
): SessionSummaryWithGoal {
  return {
    sessionId,
    cwd,
    rootSessionId,
    ...(sessionId === rootSessionId ? {} : { parentSessionId: rootSessionId }),
    agentName: sessionId === rootSessionId ? "lead" : "explore",
    profile: sessionId === rootSessionId ? "principal" : "fast",
    activeSkillNames: [],
    modelSelection: { revision: 0 },
    title,
    createdAt: 1,
    updatedAt: 2,
  };
}
