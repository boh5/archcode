import { describe, expect, test } from "bun:test";
import type { ToolChildSessionLink, ToolPart } from "@archcode/protocol";
import { buildDelegationCardViewModel } from "./delegation-card-model";

function makePart(overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    type: "tool",
    id: "part-1",
    state: "running",
    toolCallId: "call-1",
    toolName: "delegate",
    input: { agent_type: "explore", profile: "fast", skills: ["analyze-work"], background: true, title: "Inspect source", objective: "Inspect the source" },
    createdAt: 100,
    startedAt: 120,
    ...overrides,
  } as ToolPart;
}

function makeLink(overrides: Partial<ToolChildSessionLink> = {}): ToolChildSessionLink {
  return {
    parentSessionId: "parent-1",
    parentToolCallId: "call-1",
    toolName: "delegate",
    childSessionId: "child-1",
    childAgentName: "explore", childProfile: "fast", childSkillNames: [],
    title: "Child title",
    depth: 2,
    background: false,
    status: "running",
    createdAt: 100,
    startedAt: 140,
    ...overrides,
  };
}

describe("delegation card view-model", () => {
  test("uses persisted child-link metadata over tool input", () => {
    const model = buildDelegationCardViewModel({
      part: makePart(),
      projectSlug: "demo",
      focusStoreSessionId: "root-1",
      childSessionLinks: [makeLink({
        title: "Child title",
        depth: 3,
      })],
    });

    expect(model).toMatchObject({
      sessionId: "child-1",
      taskTitle: "Child title",
      visualKind: "running",
      executionStatusLabel: "Running",
      startedAt: 140,
      hasInput: true,
      input: {
        agent_type: "explore",
        profile: "fast",
        skills: ["analyze-work"],
        background: true,
        title: "Inspect source",
        objective: "Inspect the source",
      },
      canNavigate: true,
    });
  });

  test("uses tool execution state without a link while preserving recorded input", () => {
    const model = buildDelegationCardViewModel({
      part: makePart({ state: "error", createdAt: 200 } as Partial<ToolPart>),
      projectSlug: "demo",
      focusStoreSessionId: "root-1",
      childSessionLinks: [],
    });

    expect(model).toMatchObject({
      sessionId: "",
      visualKind: "failed",
      executionStatusLabel: "Stopped",
      executionStatusDetail: "Error",
      startedAt: 120,
      hasInput: true,
      canNavigate: false,
    });
  });

  test("passes through an empty recorded input without fabricating fields", () => {
    const model = buildDelegationCardViewModel({
      part: makePart({ input: {} }),
      projectSlug: "demo",
      focusStoreSessionId: "root-1",
      childSessionLinks: [],
    });

    expect(model.hasInput).toBe(true);
    expect(model.input).toEqual({});
    expect(model.taskTitle).toBeUndefined();
  });

  test("distinguishes a pending part with no recorded input", () => {
    const pendingPart: ToolPart = {
      type: "tool",
      id: "part-pending",
      state: "pending",
      toolCallId: "call-pending",
      toolName: "delegate",
      createdAt: 200,
    };
    const model = buildDelegationCardViewModel({
      part: pendingPart,
      projectSlug: "demo",
      focusStoreSessionId: "root-1",
      childSessionLinks: [],
    });

    expect(model.hasInput).toBe(false);
    expect(model.input).toBeUndefined();
  });

  test("maps terminal child execution states without a second task status", () => {
    const terminalCases = [
      ["completed", "completed"],
      ["failed", "failed"],
      ["timed_out", "failed"],
      ["cancelled", "stopped"],
      ["interrupted", "stopped"],
    ] as const;

    for (const [linkStatus, visualKind] of terminalCases) {
      const model = buildDelegationCardViewModel({
        part: makePart({ state: linkStatus === "completed" ? "completed" : "error" }),
        projectSlug: "demo",
        focusStoreSessionId: "root-1",
        childSessionLinks: [makeLink({ status: linkStatus })],
      });
      expect(model.visualKind).toBe(visualKind);
      if (linkStatus !== "completed") {
        expect(model.executionStatusLabel).toBe("Stopped");
      }
    }
  });

  test("maps non-terminal child execution states", () => {
    for (const linkStatus of ["linked", "running", "waiting_for_human", "cancelling"] as const) {
      const model = buildDelegationCardViewModel({
        part: makePart(), projectSlug: "demo", focusStoreSessionId: "root-1",
        childSessionLinks: [makeLink({ status: linkStatus })],
      });
      expect(model.visualKind).toBe(linkStatus === "waiting_for_human" ? "needs_you" : "running");
    }
  });

  test("uses tool execution state when the child link is absent", () => {
    const completed = buildDelegationCardViewModel({
      part: makePart({ state: "completed" }), projectSlug: "demo", focusStoreSessionId: "root-1",
      childSessionLinks: [],
    });
    expect(completed.visualKind).toBe("completed");
  });
});
