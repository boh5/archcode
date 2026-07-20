import { beforeEach, describe, expect, test } from "bun:test";
import type { HitlView } from "@archcode/protocol";
import { applyHitlMutationResult } from "../api/mutations";
import { hitlStore, scopedHitlKey, selectAttentionVisibleScopedHitl, selectSessionFamilyHitl } from "./hitl-store";

describe("HITL store mutation reconciliation", () => {
  beforeEach(() => hitlStore.getState().reset());

  test("answered HTTP response removes the card before SSE and duplicate SSE is idempotent", () => {
    const pending = view({ status: "pending" });
    hitlStore.getState().applyRealtimeEvent(event("proj", pending));

    const answered = view({ status: "answered" });
    applyHitlMutationResult("proj", { hitlId: answered.hitlId, status: answered.status, view: answered });
    expect(hitlStore.getState().views[key("proj", answered)]).toBeUndefined();

    hitlStore.getState().applyRealtimeEvent(event("proj", answered, "hitl.updated"));
    expect(hitlStore.getState().views[key("proj", answered)]).toBeUndefined();
  });

  test("answered views requiring inspection remain visible", () => {
    hitlStore.getState().applyRealtimeEvent(event("proj", view({ status: "pending", requiresInspection: true })));
    const answered = view({ status: "answered", requiresInspection: true });
    applyHitlMutationResult("proj", { hitlId: answered.hitlId, status: answered.status, view: answered });
    expect(hitlStore.getState().views[key("proj", answered)]?.view).toEqual(answered);
  });

  test("snapshot retains answered entries requiring inspection", () => {
    const answered = view({ status: "answered", requiresInspection: true });
    hitlStore.getState().applySnapshot({ type: "hitl.snapshot", projectSlugs: ["proj"], entries: [entry("proj", answered)], createdAt: 1 });
    expect(hitlStore.getState().views[key("proj", answered)]?.view).toEqual(answered);
  });
});

describe("scoped HITL projection", () => {
  test("keeps same HITL ids in different projects distinct and aggregates a root family", () => {
    const root = { ...entry("alpha", view({ hitlId: "same", owner: { type: "session", id: "root" } })), rootSessionId: "root" };
    const child = { ...entry("alpha", view({ hitlId: "child", owner: { type: "session", id: "child" } })), rootSessionId: "root" };
    const other = entry("beta", view({ hitlId: "same", owner: { type: "session", id: "root" } }));

    const all = selectAttentionVisibleScopedHitl([root, child, other]);
    expect(all).toHaveLength(3);
    expect(selectSessionFamilyHitl(all, "alpha", "root").map((item) => item.view.hitlId)).toEqual(["child", "same"]);
  });

  test("scopes same-id rows by project and owner while excluding resolved non-inspection rows", () => {
    const root = { ...entry("alpha", view({ hitlId: "same", createdAt: "2026-07-14T00:02:00.000Z" })), rootSessionId: "root" };
    const child = {
      ...entry("alpha", view({ hitlId: "same", owner: { type: "session", id: "child" }, createdAt: "2026-07-14T00:01:00.000Z" })),
      rootSessionId: "root",
    };
    const inspected = {
      ...entry("alpha", view({ hitlId: "inspected", status: "answered", requiresInspection: true, createdAt: "2026-07-14T00:00:00.000Z" })),
      rootSessionId: "root",
    };
    const resolved = { ...entry("alpha", view({ hitlId: "resolved", status: "answered" })), rootSessionId: "root" };
    const otherProject = { ...entry("beta", view({ hitlId: "same", owner: { type: "session", id: "root" } })), rootSessionId: "root" };

    const all = selectAttentionVisibleScopedHitl([root, child, inspected, resolved, otherProject]);
    expect(all.map((item) => `${item.projectSlug}/${item.ownerSessionId}/${item.view.hitlId}`)).toEqual([
      "alpha/session-1/inspected",
      "beta/root/same",
      "alpha/child/same",
      "alpha/session-1/same",
    ]);
    expect(selectAttentionVisibleScopedHitl(all, ["alpha"]).map((item) => item.view.hitlId)).toEqual([
      "inspected",
      "same",
      "same",
    ]);
    expect(selectSessionFamilyHitl(all, "alpha", "root").map((item) => item.view.hitlId)).toEqual([
      "inspected",
      "same",
      "same",
    ]);
  });
});

function entry(projectSlug: string, value: HitlView) {
  return { projectSlug, hitlId: value.hitlId, ownerSessionId: value.owner.id, rootSessionId: "root-1", view: value };
}

function event(projectSlug: string, value: HitlView, type: "hitl.request" | "hitl.updated" = "hitl.request") {
  return { type: "hitl.event" as const, ...entry(projectSlug, value), createdAt: 1, payload: { type } };
}

function key(projectSlug: string, value: HitlView): string {
  return scopedHitlKey(entry(projectSlug, value));
}

function view(overrides: Partial<HitlView>): HitlView {
  return {
    hitlId: "hitl-1",
    owner: { type: "session", id: "session-1" },
    source: { type: "ask_user", toolCallId: "call-1" },
    status: "pending",
    displayPayload: { title: "Need input", redacted: true },
    allowedActions: ["answer", "cancel"],
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}
