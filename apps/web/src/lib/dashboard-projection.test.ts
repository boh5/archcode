import { describe, expect, test } from "bun:test";
import type { DashboardAutomation, DashboardProjection, DashboardRootSession, HitlView, SessionGoal } from "@archcode/protocol";
import type { ScopedHitlView } from "../store/hitl-store";
import { deriveDashboardSections, type DashboardReadProjection } from "./dashboard-projection";

const ISO = "2026-07-20T00:00:00.000Z";

function read(overrides: Partial<DashboardReadProjection> = {}): DashboardReadProjection {
  return { sessions: [], automations: [], errors: [], ...overrides };
}

function session(overrides: Partial<DashboardRootSession> = {}): DashboardRootSession {
  return {
    projectSlug: "alpha", projectName: "Alpha", rootSessionId: "root", sessionTitle: "Root work", createdAt: 1, updatedAt: 1_000,
    ...overrides,
  };
}

function automation(overrides: Partial<DashboardAutomation> = {}): DashboardAutomation {
  return {
    projectSlug: "alpha", projectName: "Alpha", id: "auto", name: "Nightly", status: "active", createdAt: ISO, updatedAt: ISO,
    ...overrides,
  };
}

function hitl(overrides: Omit<Partial<ScopedHitlView>, "view"> & { view?: Partial<HitlView> } = {}): ScopedHitlView {
  const { view: viewOverrides, ...entryOverrides } = overrides;
  return {
    projectSlug: "alpha", ownerSessionId: "child", rootSessionId: "root",
    view: {
      hitlId: "ask", owner: { type: "session", id: "child" }, source: { type: "ask_user", toolCallId: "tool" }, status: "pending",
      allowedActions: ["answer"], createdAt: ISO, updatedAt: ISO, displayPayload: { title: "Need input", redacted: true },
      ...viewOverrides,
    },
    ...entryOverrides,
  };
}

function goal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    instanceId: "goal", generation: 1, objective: "Ship", status: "blocked", createdAt: 1, activatedAt: 1, updatedAt: 3_000,
    usage: { tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 }, executionTimeMs: 0, executionCount: 0 },
    ...overrides,
  };
}

describe("deriveDashboardSections", () => {
  test("keeps every attention item but removes its family from lower sections", () => {
    const result = deriveDashboardSections({
      read: read({
        sessions: [
          session({
            goal: goal(),
            latestExecution: { id: "exec", status: "failed", startedAt: 1_000, endedAt: 4_000 },
          }),
          session({ rootSessionId: "available", sessionTitle: "Continue", updatedAt: 2_000 }),
        ],
        automations: [automation({ nextFireAt: "2026-07-21T00:00:00.000Z" })],
      }),
      hitl: [hitl(), hitl({ view: { hitlId: "inspect", createdAt: "2026-07-20T00:01:00.000Z", requiresInspection: true, displayPayload: { title: "Inspect", redacted: true } } })],
      activityFor: (_project, root) => root === "available" ? "running" : "idle",
    });

    expect(result.attention.map((item) => item.kind)).toEqual(["hitl", "hitl", "goal", "session_failure"]);
    expect(result.attention[0]?.identity).toContain("inspect");
    expect(result.running.map((item) => item.rootSessionId)).toEqual(["available"]);
    expect(result.continueWorking).toEqual([]);
    expect(result.upcoming.map((item) => item.automationId)).toEqual(["auto"]);
  });

  test("applies section limits only after mutual exclusion and stable ordering", () => {
    const sessions = Array.from({ length: 12 }, (_, index) => session({
      rootSessionId: `root-${index}`,
      updatedAt: 12 - index,
    }));
    const automations = Array.from({ length: 12 }, (_, index) => automation({
      id: `auto-${index}`,
      nextFireAt: `2026-07-${String(30 - index).padStart(2, "0")}T00:00:00.000Z`,
    }));
    automations[0] = automation({
      id: "failed",
      nextFireAt: "2026-07-01T00:00:00.000Z",
      latestInvocation: { id: "i", status: "failed", createdAt: ISO },
    });

    const result = deriveDashboardSections({ read: read({ sessions, automations }), hitl: [], activityFor: () => "idle" });

    expect(result.continueWorking).toHaveLength(10);
    expect(result.continueWorking[0]?.rootSessionId).toBe("root-0");
    expect(result.upcoming).toHaveLength(10);
    expect(result.upcoming.map((item) => item.automationId)).not.toContain("failed");
    expect(result.attention.map((item) => item.identity)).toEqual(["automation:alpha:failed:i"]);
  });

  test("rejects invalid attention timestamps rather than inventing an ordering", () => {
    expect(() => deriveDashboardSections({
      read: read(),
      hitl: [hitl({ view: { hitlId: "bad", createdAt: "not-a-date", displayPayload: { title: "Bad", redacted: true } } })],
      activityFor: () => "idle",
    })).toThrow("invalid ISO timestamp");
  });

  test("does not treat an uninitialized runtime projection as idle", () => {
    const result = deriveDashboardSections({
      read: read({ sessions: [session()] }),
      hitl: [],
      activityFor: () => undefined,
    });

    expect(result.continueWorking).toEqual([]);
  });

  test("removes recovered Goal and Session failures from attention on the next read", () => {
    const blocked = deriveDashboardSections({
      read: read({
        sessions: [session({
          goal: goal({ status: "blocked" }),
          latestExecution: { id: "failed", status: "failed", startedAt: 1_000, endedAt: 2_000 },
        })],
      }),
      hitl: [],
      activityFor: () => "idle",
    });
    expect(blocked.attention.map((item) => item.kind)).toEqual(["goal", "session_failure"]);

    const recovered = deriveDashboardSections({
      read: read({
        sessions: [session({
          goal: goal({ status: "active", updatedAt: 4_000 }),
          latestExecution: { id: "next", status: "running", startedAt: 4_000 },
        })],
      }),
      hitl: [],
      activityFor: () => "running",
    });
    expect(recovered.attention).toEqual([]);
    expect(recovered.running.map((item) => item.rootSessionId)).toEqual(["root"]);
  });

  test("treats budget limits and timed out work as attention until their latest state recovers", () => {
    const limited = deriveDashboardSections({
      read: read({
        sessions: [session({
          goal: goal({ status: "budget_limited" }),
          latestExecution: { id: "timeout", status: "timed_out", startedAt: 1_000, endedAt: 2_000 },
        })],
      }),
      hitl: [],
      activityFor: () => "idle",
    });
    expect(limited.attention.map((item) => item.kind)).toEqual(["goal", "session_failure"]);

    const resumed = deriveDashboardSections({
      read: read({
        sessions: [session({
          goal: goal({ status: "active", updatedAt: 3_000 }),
          latestExecution: { id: "completed", status: "completed", startedAt: 3_000, endedAt: 4_000 },
        })],
      }),
      hitl: [],
      activityFor: () => "idle",
    });
    expect(resumed.attention).toEqual([]);
    expect(resumed.continueWorking.map((item) => item.rootSessionId)).toEqual(["root"]);
  });

  test("keeps all four sections mutually exclusive while preserving each section's ordering", () => {
    const result = deriveDashboardSections({
      read: read({
        sessions: [
          session({ rootSessionId: "attention", updatedAt: 999 }),
          session({ rootSessionId: "stopping", updatedAt: 900 }),
          session({ rootSessionId: "running", updatedAt: 100 }),
          session({ rootSessionId: "older-idle", updatedAt: 10 }),
          session({ rootSessionId: "newer-idle", updatedAt: 20 }),
        ],
        automations: [
          automation({ id: "later", nextFireAt: "2026-07-22T00:00:00.000Z" }),
          automation({ id: "earlier", nextFireAt: "2026-07-21T00:00:00.000Z" }),
          automation({ id: "failed", latestInvocation: { id: "latest", status: "failed", createdAt: ISO } }),
        ],
      }),
      hitl: [hitl({ rootSessionId: "attention" })],
      activityFor: (_project, rootSessionId) => {
        if (rootSessionId === "running") return "running";
        if (rootSessionId === "stopping") return "stopping";
        return "idle";
      },
    });

    expect(result.attention.map((item) => item.identity)).toEqual([
      "hitl:alpha:child:ask",
      "automation:alpha:failed:latest",
    ]);
    expect(result.running.map((item) => item.rootSessionId)).toEqual(["running", "stopping"]);
    expect(result.continueWorking.map((item) => item.rootSessionId)).toEqual(["newer-idle", "older-idle"]);
    expect(result.upcoming.map((item) => item.automationId)).toEqual(["earlier", "later"]);

    const sectionOwners = [
      ...result.attention.map((item) => `attention:${item.sectionOwnerKey}`),
      ...result.running.map((item) => `running:${item.sectionOwnerKey}`),
      ...result.continueWorking.map((item) => `continue:${item.sectionOwnerKey}`),
      ...result.upcoming.map((item) => `upcoming:${item.sectionOwnerKey}`),
    ];
    expect(sectionOwners).not.toContain("running:session-family:alpha:attention");
    expect(sectionOwners).not.toContain("continue:session-family:alpha:attention");
    expect(sectionOwners).not.toContain("upcoming:automation:alpha:failed");
  });
});
