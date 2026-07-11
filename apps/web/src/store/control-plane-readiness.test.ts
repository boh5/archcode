import { beforeEach, describe, expect, test } from "bun:test";
import {
  invalidateControlPlaneReadiness,
  removeProjectControlPlane,
} from "./control-plane-readiness";
import { hitlStore } from "./hitl-store";
import { sessionRuntimeStore } from "./session-runtime-store";

describe("control-plane readiness lifecycle", () => {
  beforeEach(() => {
    sessionRuntimeStore.getState().reset();
    hitlStore.getState().reset();
  });

  test("only authoritative snapshots initialize a newly registered project", () => {
    sessionRuntimeStore.getState().applyChange({
      type: "session.runtime_changed",
      projectSlug: "proj",
      rootSessionId: "root-1",
      activity: "running",
      createdAt: 1,
    });

    expect(sessionRuntimeStore.getState().isProjectInitialized("proj")).toBe(false);
    expect(hitlStore.getState().isProjectInitialized("proj")).toBe(false);
  });

  test("project removal clears runtime and HITL state together", () => {
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["proj"],
      families: [{ projectSlug: "proj", rootSessionId: "root-1", activity: "running" }],
      createdAt: 1,
    });
    hitlStore.getState().applySnapshot({
      type: "hitl.snapshot",
      projectSlugs: ["proj"],
      projections: [],
      createdAt: 1,
    });

    removeProjectControlPlane("proj");

    expect(sessionRuntimeStore.getState().isProjectInitialized("proj")).toBe(false);
    expect(sessionRuntimeStore.getState().families).toEqual({});
    expect(hitlStore.getState().isProjectInitialized("proj")).toBe(false);
  });

  test("disconnect invalidates both readiness projections", () => {
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["proj"],
      families: [],
      createdAt: 1,
    });
    hitlStore.getState().applySnapshot({
      type: "hitl.snapshot",
      projectSlugs: ["proj"],
      projections: [],
      createdAt: 1,
    });

    invalidateControlPlaneReadiness();

    expect(sessionRuntimeStore.getState().isProjectInitialized("proj")).toBe(false);
    expect(hitlStore.getState().isProjectInitialized("proj")).toBe(false);
  });
});
