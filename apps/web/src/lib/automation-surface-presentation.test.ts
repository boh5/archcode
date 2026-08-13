import { describe, expect, test } from "bun:test";
import type {
  Automation,
  AutomationInvocation,
  ProjectAutomationInventoryItem,
  ProjectSessionInventoryItem,
} from "@archcode/protocol";
import type { AutomationHitlAttention, AutomationSessionLink } from "./automation-hitl-attention";
import { presentAutomationSurface } from "./automation-surface-presentation";

const automation: Automation = {
  id: "automation-secret-id",
  projectSlug: "demo",
  origin: { kind: "direct" },
  name: "Regression check",
  trigger: { kind: "interval", everyMs: 60_000 },
  action: { kind: "start_session", message: "Inspect regressions and report actionable failures.", location: "project" },
  status: "active",
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
  nextFireAt: "2026-08-14T01:00:00.000Z",
};

function invocation(status: AutomationInvocation["status"]): AutomationInvocation {
  return {
    id: `invocation-${status}`,
    automationId: automation.id,
    dueAt: "2026-08-13T01:00:00.000Z",
    status,
    createdAt: "2026-08-13T01:00:00.000Z",
  };
}

const noAttention: AutomationHitlAttention = { kind: "start_session", sessions: [] };

function present(input: {
  value?: Automation;
  latestInvocation?: AutomationInvocation | null;
  attention?: AutomationHitlAttention;
  sessionLinks?: AutomationSessionLink[];
  targetSession?: ProjectSessionInventoryItem;
  activity?: ReadonlyMap<string, "running" | "waiting_for_human" | "resuming" | "stopping" | "idle">;
}) {
  const item: ProjectAutomationInventoryItem = {
    automation: input.value ?? automation,
    latestInvocation: input.latestInvocation ?? null,
  };
  return presentAutomationSurface({
    item,
    attention: input.attention ?? noAttention,
    sessionLinks: input.sessionLinks ?? [],
    targetSession: input.targetSession,
    activityBySessionId: input.activity ?? new Map(),
    now: new Date(2026, 7, 13, 8, 0).getTime(),
  });
}

describe("Automation surface presentation", () => {
  test("gives failed and missed Invocations absolute precedence over HITL and definition state", () => {
    const attention: AutomationHitlAttention = {
      kind: "start_session",
      sessions: [{ invocationId: "old", sessionId: "root", entries: [{} as never] }],
    };
    const disabled = { ...automation, status: "disabled" as const };

    expect(present({ value: disabled, latestInvocation: invocation("failed"), attention })).toMatchObject({
      group: "needs-you", statusLabel: "Failed", rowSignal: "Failed", tone: "error", orbit: "failed",
    });
    expect(present({ value: disabled, latestInvocation: invocation("missed"), attention })).toMatchObject({
      group: "needs-you", statusLabel: "Missed", rowSignal: "Missed", tone: "error", orbit: "failed",
    });
  });

  test("shows only exact linked human gates as Needs you", () => {
    const attention: AutomationHitlAttention = {
      kind: "start_session",
      sessions: [{ invocationId: "invocation-1", sessionId: "root-1", entries: [{} as never] }],
    };
    expect(present({ attention })).toMatchObject({
      group: "needs-you", statusLabel: "Needs you", tone: "attention", orbit: "attention",
    });
    expect(present({ attention: noAttention })).toMatchObject({ group: "scheduled", statusLabel: "Scheduled" });
  });

  test("reserves the running orbit for a linked Session that is actually running", () => {
    const sessionLinks: AutomationSessionLink[] = [{
      invocationId: "invocation-dispatched",
      sessionId: "root-1",
      latestExecution: { id: "execution-1", status: "running", startedAt: 1 },
    }];
    expect(present({ latestInvocation: invocation("dispatched"), sessionLinks })).toMatchObject({
      group: "scheduled", statusLabel: "Running", rowSignal: "Running", tone: "running", orbit: "running",
    });
    expect(present({ latestInvocation: invocation("dispatched") })).toMatchObject({
      group: "scheduled", statusLabel: "Scheduled", tone: "neutral", orbit: "scheduled",
    });
  });

  test("maps send_message to its exact target Session without exposing its ID in row syntax", () => {
    const sendMessage = {
      ...automation,
      action: { kind: "send_message" as const, sessionId: "target-secret-id", message: "Continue the release review." },
    };
    const targetSession = {
      session: { sessionId: "target-secret-id", source: { kind: "direct" } },
      latestExecution: { id: "execution-target", status: "running", startedAt: 1 },
    } as ProjectSessionInventoryItem;
    const result = present({ value: sendMessage, targetSession });

    expect(result).toMatchObject({
      statusLabel: "Running",
      actionLabel: "Existing Session",
      locationLabel: "Target Session workspace",
      bindingLabel: "Target Session’s existing Agent + Profile",
    });
    expect(result.context).not.toContain("target-secret-id");
    expect(result.context).not.toContain("Send message");
    expect(result.context).not.toContain("automation-secret-id");
  });

  test("uses one trailing schedule signal for a static scheduled definition", () => {
    const result = present({});
    expect(result.statusLabel).toBe("Scheduled");
    expect(result.rowSignal).not.toContain("Scheduled ·");
    expect(result.context).toContain("Inspect regressions");
    expect(result.context).not.toContain(automation.id);
  });
});
