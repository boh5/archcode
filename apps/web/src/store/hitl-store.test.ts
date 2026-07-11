import { beforeEach, describe, expect, test } from "bun:test";
import type { GlobalSSEHitlRealtimeEvent, HitlProjection } from "@archcode/protocol";
import { hitlIdentityKey, hitlStore, selectHitlProjections } from "./hitl-store";

describe("hitlStore", () => {
  beforeEach(() => {
    hitlStore.getState().reset();
  });

  test("upserts active realtime projections and removes terminal projections", () => {
    const request = hitlEvent({ hitlId: "hitl-1" });
    hitlStore.getState().applyRealtimeEvent(request);

    expect(hitlStore.getState().projections[hitlIdentityKey(request.projection)]).toEqual(request.projection);

    hitlStore.getState().applyRealtimeEvent(hitlEvent({ hitlId: "hitl-1", status: "resolved", payloadType: "hitl.resolved" }));

    expect(hitlStore.getState().projections[hitlIdentityKey(request.projection)]).toBeUndefined();
  });

  test("removes resume_claimed projections from the visible realtime queue", () => {
    const request = hitlEvent({ hitlId: "hitl-claimed" });
    hitlStore.getState().applyRealtimeEvent(request);

    hitlStore.getState().applyRealtimeEvent(hitlEvent({
      hitlId: "hitl-claimed",
      status: "resume_claimed",
      payloadType: "hitl.updated",
    }));

    expect(hitlStore.getState().projections[hitlIdentityKey(request.projection)]).toBeUndefined();
  });

  test("keeps the same hitlId under different owners as separate projections", () => {
    const first = hitlEvent({ hitlId: "shared-id", ownerId: "session-1" });
    const second = hitlEvent({ hitlId: "shared-id", ownerId: "session-2" });

    hitlStore.getState().applyRealtimeEvent(first);
    hitlStore.getState().applyRealtimeEvent(second);

    expect(Object.values(hitlStore.getState().projections)).toEqual(expect.arrayContaining([
      first.projection,
      second.projection,
    ]));
    expect(Object.values(hitlStore.getState().projections)).toHaveLength(2);
  });

  test("authoritative snapshot atomically replaces listed projects and marks them initialized", () => {
    const stale = projection({ hitlId: "stale", project: { slug: "proj" } });
    const fresh = projection({ hitlId: "fresh", project: { slug: "proj" } });
    const otherProject = projection({ hitlId: "other", project: { slug: "other" } });
    hitlStore.setState({ projections: { stale, other: otherProject } });

    hitlStore.getState().applySnapshot({
      type: "hitl.snapshot",
      projectSlugs: ["proj"],
      projections: [fresh],
      createdAt: 1,
    });

    expect(Object.values(hitlStore.getState().projections)).toEqual([otherProject, fresh]);
    expect(hitlStore.getState().isProjectInitialized("proj")).toBe(true);
    expect(hitlStore.getState().isProjectInitialized("other")).toBe(false);
  });

  test("global snapshot with no registered projects clears projections and readiness", () => {
    hitlStore.setState({ projections: { stale: projection({ hitlId: "stale" }) } });

    hitlStore.getState().applySnapshot({
      type: "hitl.snapshot",
      projectSlugs: [],
      projections: [],
      createdAt: 1,
    });

    expect(hitlStore.getState().projections).toEqual({});
    expect(hitlStore.getState().initializedProjects).toEqual({});
  });

  test("disconnect invalidates readiness without pretending cached projections are current", () => {
    const pending = projection({ hitlId: "pending" });
    hitlStore.getState().applySnapshot({
      type: "hitl.snapshot",
      projectSlugs: ["proj"],
      projections: [pending],
      createdAt: 1,
    });

    hitlStore.getState().invalidateSnapshots();

    expect(hitlStore.getState().isProjectInitialized("proj")).toBe(false);
    expect(Object.values(hitlStore.getState().projections)).toEqual([pending]);
  });

  test("an early live projection cannot initialize a newly registered project without a snapshot", () => {
    const early = hitlEvent({ hitlId: "early" });
    hitlStore.getState().applyRealtimeEvent(early);

    expect(hitlStore.getState().isProjectInitialized("proj")).toBe(false);
    expect(hitlStore.getState().projections[hitlIdentityKey(early.projection)]).toEqual(early.projection);
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
      source: { type: "goal_budget", goalId: "goal-1", approvalPoint: "budget" , resumeStatus: "running"},
      ancestry: { goalId: "goal-1", loopId: "loop-1", projectionPath: ["loop", "loop-1", "goal", "goal-1"] },
    });

    expect(selectHitlProjections([goalHitl], { slug: "proj", scope: "loop", ownerId: "loop-1", includeChildren: true })).toEqual([goalHitl]);
  });
});

function hitlEvent(input: { hitlId: string; ownerId?: string; status?: HitlProjection["status"]; payloadType?: "hitl.request" | "hitl.updated" | "hitl.resolved" }): GlobalSSEHitlRealtimeEvent {
  const eventProjection = projection({
    hitlId: input.hitlId,
    status: input.status ?? "pending",
    ...(input.ownerId === undefined ? {} : {
      owner: { projectSlug: "proj", ownerType: "session", ownerId: input.ownerId },
    }),
  });
  return {
    type: "hitl.event",
    projectSlug: eventProjection.project.slug,
    owner: eventProjection.owner,
    hitlId: eventProjection.hitlId,
    createdAt: 1,
    payload: input.payloadType === "hitl.resolved"
      ? { type: "hitl.resolved", status: "resolved" }
      : input.payloadType === "hitl.updated"
        ? { type: "hitl.updated", status: eventProjection.status }
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
