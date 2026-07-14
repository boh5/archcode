import { beforeEach, describe, expect, test } from "bun:test";
import type { HitlView } from "@archcode/protocol";
import { applyHitlMutationResult } from "../api/mutations";
import { hitlStore, scopedHitlKey } from "./hitl-store";

describe("HITL store mutation reconciliation", () => {
  beforeEach(() => hitlStore.getState().reset());

  test("answered HTTP response removes the card before SSE and duplicate SSE is idempotent", () => {
    const pending = view({ status: "pending" });
    hitlStore.getState().applyScopedView("proj", pending);

    const answered = view({ status: "answered" });
    applyHitlMutationResult("proj", { hitlId: answered.hitlId, status: answered.status, view: answered });
    expect(hitlStore.getState().views[scopedHitlKey("proj", answered)]).toBeUndefined();

    hitlStore.getState().applyRealtimeEvent({ type: "hitl.event", projectSlug: "proj", hitlId: answered.hitlId, createdAt: 1, payload: { type: "hitl.updated" }, view: answered });
    expect(hitlStore.getState().views[scopedHitlKey("proj", answered)]).toBeUndefined();
  });

  test("answered views requiring inspection remain visible", () => {
    const answered = view({ status: "answered", requiresInspection: true });
    applyHitlMutationResult("proj", { hitlId: answered.hitlId, status: answered.status, view: answered });
    expect(hitlStore.getState().views[scopedHitlKey("proj", answered)]?.view).toEqual(answered);
  });

  test("snapshot retains answered entries requiring inspection", () => {
    const answered = view({ status: "answered", requiresInspection: true });
    hitlStore.getState().applySnapshot({ type: "hitl.snapshot", projectSlugs: ["proj"], entries: [{ projectSlug: "proj", view: answered }], createdAt: 1 });
    expect(hitlStore.getState().views[scopedHitlKey("proj", answered)]?.view).toEqual(answered);
  });
});

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
