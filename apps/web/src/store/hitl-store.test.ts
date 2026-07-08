import { beforeEach, describe, expect, test } from "bun:test";
import type { GlobalSSEHitlRealtimeEvent, HitlProjection } from "@archcode/protocol";
import { hitlStore, selectHitlProjections } from "./hitl-store";

describe("hitlStore", () => {
  beforeEach(() => {
    hitlStore.setState({ projections: {} });
  });

  test("upserts active realtime projections and removes terminal projections", () => {
    const request = hitlEvent({ hitlId: "hitl-1" });
    hitlStore.getState().applyRealtimeEvent(request);

    expect(hitlStore.getState().projections["hitl-1"]).toEqual(request.projection);

    hitlStore.getState().applyRealtimeEvent(hitlEvent({ hitlId: "hitl-1", status: "resolved", payloadType: "hitl.resolved" }));

    expect(hitlStore.getState().projections["hitl-1"]).toBeUndefined();
  });

  test("authoritative snapshot reset clears stale projections for listed projects", () => {
    const stale = projection({ hitlId: "stale", project: { slug: "proj" } });
    const otherProject = projection({ hitlId: "other", project: { slug: "other" } });
    hitlStore.setState({ projections: { stale, other: otherProject } });

    hitlStore.getState().applySnapshotReset(["proj"]);

    expect(hitlStore.getState().projections).toEqual({ other: otherProject });
  });

  test("global snapshot reset with no project slugs clears all projections", () => {
    hitlStore.setState({ projections: { stale: projection({ hitlId: "stale" }) } });

    hitlStore.getState().applySnapshotReset([]);

    expect(hitlStore.getState().projections).toEqual({});
  });

  test("selects session descendants using ancestry", () => {
    const child = projection({
      hitlId: "child-hitl",
      owner: { projectSlug: "proj", ownerType: "session", ownerId: "child" },
      ancestry: { rootSessionId: "root", parentSessionId: "root", ancestorSessionIds: ["root"], projectionPath: ["session", "root", "child"] },
    });

    expect(selectHitlProjections([child], { slug: "proj", scope: "session", ownerId: "root", includeChildren: true })).toEqual([child]);
    expect(selectHitlProjections([child], { slug: "proj", scope: "session", ownerId: "root", includeChildren: false })).toEqual([]);
  });

  test("selects goal HITL under loop scope through ancestry", () => {
    const goalHitl = projection({
      hitlId: "goal-hitl",
      owner: { projectSlug: "proj", ownerType: "goal", ownerId: "goal-1" },
      source: { type: "goal_budget", goalId: "goal-1", approvalPoint: "budget" },
      ancestry: { goalId: "goal-1", loopId: "loop-1", projectionPath: ["loop", "loop-1", "goal", "goal-1"] },
    });

    expect(selectHitlProjections([goalHitl], { slug: "proj", scope: "loop", ownerId: "loop-1", includeChildren: true })).toEqual([goalHitl]);
  });
});

function hitlEvent(input: { hitlId: string; status?: HitlProjection["status"]; payloadType?: "hitl.request" | "hitl.resolved" }): GlobalSSEHitlRealtimeEvent {
  const eventProjection = projection({ hitlId: input.hitlId, status: input.status ?? "pending" });
  return {
    type: "hitl.event",
    projectSlug: eventProjection.project.slug,
    owner: eventProjection.owner,
    hitlId: eventProjection.hitlId,
    createdAt: 1,
    payload: input.payloadType === "hitl.resolved"
      ? { type: "hitl.resolved", status: "resolved" }
      : { type: "hitl.request", status: "pending" },
    projection: eventProjection,
  };
}

function projection(input: Partial<HitlProjection> & { hitlId: string }): HitlProjection {
  const owner = input.owner ?? { projectSlug: "proj", ownerType: "session", ownerId: "session-1" };
  return {
    hitlId: input.hitlId,
    project: input.project ?? { slug: "proj" },
    owner,
    source: input.source ?? { type: "ask_user", sessionId: owner.ownerId, toolCallId: "call-1" },
    status: input.status ?? "pending",
    displayPayload: input.displayPayload ?? {
      title: "Need input",
      questions: [{ header: "Q1", question: "Continue?", options: [], custom: true }],
      redacted: true,
    },
    allowedActions: input.allowedActions ?? ["answer", "cancel"],
    createdAt: input.createdAt ?? "2026-07-08T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-07-08T00:00:00.000Z",
    ...(input.ancestry === undefined ? {} : { ancestry: input.ancestry }),
  };
}
