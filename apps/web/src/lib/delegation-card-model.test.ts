import { describe, expect, test } from "bun:test";
import type { AgentDescriptor, ToolChildSessionLink, ToolPart } from "@archcode/protocol";
import type { BadgeStatus } from "./agent-constants";
import {
  buildDelegationCardViewModel,
  mapDelegationLinkStatusToBadge,
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
    input: { agent_type: "explore", title: "Inspect source", task: "Inspect the source" },
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
    childAgentName: "explore",
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
    expect(parseDelegationInput({ agent_type: "explore", title: "Inspect source", task: "test" })).toEqual({ agent_type: "explore", title: "Inspect source", task: "test" });
    expect(parseDelegationInput(JSON.stringify({ agent_type: "explore" }))).toEqual({ agent_type: "explore" });
    expect(parseDelegationInput(null)).toBeNull();
    expect(parseDelegationInput(undefined)).toBeNull();
    expect(parseDelegationInput("invalid")).toBeNull();

    const statuses: Array<Parameters<typeof mapDelegationLinkStatusToBadge>[0]> = [
      "linked", "running", "waiting_for_human", "cancelling", "completed", "failed", "timed_out", "cancelled", "interrupted",
    ];
    const expected: Record<typeof statuses[number], BadgeStatus> = {
      linked: "running",
      running: "running",
      waiting_for_human: "pending",
      cancelling: "running",
      completed: "completed",
      failed: "error",
      timed_out: "error",
      cancelled: "error",
      interrupted: "error",
    };
    for (const status of statuses) {
      expect(mapDelegationLinkStatusToBadge(status)).toBe(expected[status]);
    }
  });

  test("uses persisted child-link metadata over tool input", () => {
    const model = buildDelegationCardViewModel({
      part: makePart(),
      projectSlug: "demo",
      focusStoreSessionId: "root-1",
      childSessionLinks: [makeLink({ title: "Child title", summary: "Child summary", depth: 3 })],
      agentDescriptors: agents,
    });

    expect(model).toMatchObject({
      sessionId: "child-1",
      agentType: "explore",
      agentDisplayName: "Explore",
      taskTitle: "Child title",
      summary: "Child summary",
      status: "running",
      depth: 3,
      startedAt: 140,
      canNavigate: true,
      tools: [],
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
      agentType: "explore",
      taskTitle: "Inspect source",
      summary: "Inspect the source",
      status: "error",
      depth: 1,
      startedAt: 120,
      canNavigate: false,
    });
  });
});
