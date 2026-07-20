import { describe, expect, test } from "bun:test";
import type { Automation, AutomationInvocation, HitlView } from "@archcode/protocol";
import type { ScopedHitlView } from "../store/hitl-store";
import { automationHitlSessionCount, deriveAutomationHitlAttention } from "./automation-hitl-attention";

const base = {
  id: "automation-1",
  projectSlug: "demo",
  createdFromSessionId: "source",
  name: "Daily check",
  status: "active",
  trigger: { kind: "interval", everyMs: 60_000 },
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
  nextFireAt: "2026-07-20T01:00:00.000Z",
} satisfies Omit<Automation, "action">;

function hitl(rootSessionId: string, ownerSessionId = rootSessionId, hitlId = rootSessionId): ScopedHitlView {
  const view: HitlView = {
    hitlId,
    owner: { type: "session", id: ownerSessionId },
    source: { type: "ask_user", toolCallId: `tool-${hitlId}` },
    status: "pending",
    displayPayload: { title: "Question", redacted: true },
    allowedActions: ["answer", "cancel"],
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
  return { projectSlug: "demo", rootSessionId, ownerSessionId, view };
}

function invocation(id: string, sessionId: string): AutomationInvocation {
  return {
    id,
    automationId: "automation-1",
    dueAt: "2026-07-20T00:00:00.000Z",
    status: "dispatched",
    sessionId,
    createdAt: "2026-07-20T00:00:00.000Z",
  };
}

describe("Automation linked Session HITL", () => {
  test("groups start_session attention by Invocation root family", () => {
    const automation: Automation = { ...base, action: { kind: "start_session", message: "Check", location: "project" } };
    const attention = deriveAutomationHitlAttention(
      automation,
      [invocation("i1", "root-1"), invocation("i2", "root-2"), invocation("i3", "root-1")],
      [hitl("root-1"), hitl("root-1", "child-1", "child-hitl"), hitl("root-2")],
    );

    expect(attention.kind).toBe("start_session");
    expect(automationHitlSessionCount(attention)).toBe(2);
    if (attention.kind === "start_session") expect(attention.sessions[0]?.entries).toHaveLength(2);
  });

  test("describes send_message attention only as target-family state", () => {
    const automation: Automation = { ...base, action: { kind: "send_message", message: "Continue", sessionId: "root-1" } };
    const attention = deriveAutomationHitlAttention(automation, [invocation("i1", "other")], [hitl("root-1"), hitl("other")]);

    expect(attention.kind).toBe("send_message");
    expect(automationHitlSessionCount(attention)).toBe(1);
    if (attention.kind === "send_message") expect(attention.entries).toHaveLength(1);
  });

  test("keeps only the distinct Session families created by this Automation's Invocations", () => {
    const automation: Automation = { ...base, action: { kind: "start_session", message: "Check", location: "project" } };
    const attention = deriveAutomationHitlAttention(
      automation,
      [
        invocation("first-root-1", "root-1"),
        invocation("repeat-root-1", "root-1"),
        invocation("root-2", "root-2"),
      ],
      [
        hitl("root-1", "child-of-root-1", "child-request"),
        hitl("root-2", "root-2", "root-request"),
        hitl("unrelated-root", "unrelated-root", "unrelated-request"),
        { ...hitl("root-1", "other-project-owner", "wrong-project"), projectSlug: "other" },
      ],
    );

    expect(attention.kind).toBe("start_session");
    if (attention.kind === "start_session") {
      expect(attention.sessions.map((session) => [session.invocationId, session.sessionId])).toEqual([
        ["first-root-1", "root-1"],
        ["root-2", "root-2"],
      ]);
      expect(attention.sessions.flatMap((session) => session.entries).map((entry) => entry.view.hitlId)).toEqual([
        "child-request",
        "root-request",
      ]);
    }
  });

  test("shows a send_message target's entire root family without claiming an Invocation caused it", () => {
    const automation: Automation = { ...base, action: { kind: "send_message", message: "Continue", sessionId: "root-1" } };
    const attention = deriveAutomationHitlAttention(
      automation,
      [invocation("historical", "root-2")],
      [
        hitl("root-1", "root-1", "root-request"),
        hitl("root-1", "child-1", "child-request"),
        hitl("root-2", "root-2", "other-request"),
      ],
    );

    expect(attention).toMatchObject({ kind: "send_message", targetSessionId: "root-1" });
    if (attention.kind === "send_message") {
      expect(attention.entries.map((entry) => entry.view.hitlId)).toEqual(["root-request", "child-request"]);
    }
  });
});
