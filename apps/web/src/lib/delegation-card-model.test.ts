import { describe, expect, test } from "bun:test";
import type { AgentDescriptor, ToolChildSessionLink, ToolPart } from "@archcode/protocol";
import {
  buildDelegationCardViewModel,
  formatDelegationLinkStatus,
  parseDelegationInput,
} from "./delegation-card-model";

const agents: AgentDescriptor[] = [{ name: "explore", displayName: "Explore" }];

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
  test("normalizes input and maps every link status", () => {
    expect(parseDelegationInput({ agent_type: "explore", title: "Inspect source", objective: "test" })).toEqual({ agent_type: "explore", title: "Inspect source", objective: "test" });
    expect(parseDelegationInput(JSON.stringify({ agent_type: "explore" }))).toEqual({ agent_type: "explore" });
    expect(parseDelegationInput(null)).toBeNull();
    expect(parseDelegationInput(undefined)).toBeNull();
    expect(parseDelegationInput("invalid")).toBeNull();

    const statuses: ToolChildSessionLink["status"][] = [
      "linked", "running", "waiting_for_human", "cancelling", "completed", "failed", "timed_out", "cancelled", "interrupted",
    ];
    expect(statuses.map(formatDelegationLinkStatus)).toEqual([
      "Running", "Running", "Needs you", "Running", "Completed", "Stopped", "Stopped", "Stopped", "Stopped",
    ]);
  });

  test("uses persisted child-link metadata over tool input", () => {
    const model = buildDelegationCardViewModel({
      part: makePart(),
      projectSlug: "demo",
      focusStoreSessionId: "root-1",
      childSessionLinks: [makeLink({
        title: "Child title",
        depth: 3,
      })],
      agentDescriptors: agents,
    });

    expect(model).toMatchObject({
      sessionId: "child-1",
      agentDisplayName: "Explore",
      taskTitle: "Child title",
      taskSummary: "Inspect the source",
      visualKind: "running",
      executionStatusLabel: "Running",
      startedAt: 140,
      background: false,
      canNavigate: true,
    });
  });

  test("falls back to tool input and part state without a link", () => {
    const model = buildDelegationCardViewModel({
      part: makePart({ state: "error", createdAt: 200 } as Partial<ToolPart>),
      projectSlug: "demo",
      focusStoreSessionId: "root-1",
      childSessionLinks: [],
      agentDescriptors: agents,
    });

    expect(model).toMatchObject({
      sessionId: "",
      agentDisplayName: "Explore",
      taskTitle: "Inspect source",
      taskSummary: "Inspect the source",
      visualKind: "failed",
      executionStatusLabel: "Stopped",
      executionStatusDetail: "Error",
      startedAt: 120,
      profile: "fast",
      skills: ["analyze-work"],
      background: true,
      canNavigate: false,
    });
  });

  test("omits metadata that is absent instead of fabricating defaults", () => {
    const model = buildDelegationCardViewModel({
      part: makePart({ input: {} }),
      projectSlug: "demo",
      focusStoreSessionId: "root-1",
      childSessionLinks: [],
      agentDescriptors: agents,
    });

    expect(model.agentDisplayName).toBeUndefined();
    expect(model.profile).toBeUndefined();
    expect(model.background).toBeUndefined();
    expect(model.taskTitle).toBeUndefined();
    expect(model.taskSummary).toBeUndefined();
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
        agentDescriptors: agents,
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
        childSessionLinks: [makeLink({ status: linkStatus })], agentDescriptors: agents,
      });
      expect(model.visualKind).toBe(linkStatus === "waiting_for_human" ? "needs_you" : "running");
    }
  });

  test("uses tool execution state when the child link is absent", () => {
    const completed = buildDelegationCardViewModel({
      part: makePart({ state: "completed" }), projectSlug: "demo", focusStoreSessionId: "root-1",
      childSessionLinks: [], agentDescriptors: agents,
    });
    expect(completed.visualKind).toBe("completed");
  });
});
