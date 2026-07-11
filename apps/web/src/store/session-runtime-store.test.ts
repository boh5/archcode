import { beforeEach, describe, expect, test } from "bun:test";
import type {
  GlobalSSESessionRuntimeChangedEvent,
  GlobalSSESessionRuntimeSnapshotEvent,
} from "@archcode/protocol";
import {
  runtimeFamilyKey,
  sessionRuntimeStore,
} from "./session-runtime-store";

describe("sessionRuntimeStore", () => {
  beforeEach(() => {
    sessionRuntimeStore.getState().reset();
  });

  test("keeps controls uninitialized until an authoritative snapshot arrives", () => {
    const state = sessionRuntimeStore.getState();

    expect(state.isProjectInitialized("proj")).toBe(false);
    expect(state.activityFor("proj", "root-1")).toBeUndefined();

    state.applySnapshot(snapshot({ projectSlugs: ["proj"], families: [] }));

    expect(sessionRuntimeStore.getState().isProjectInitialized("proj")).toBe(true);
    expect(sessionRuntimeStore.getState().activityFor("proj", "root-1")).toBe("idle");
  });

  test("snapshot replaces all runtime projections for the listed projects", () => {
    sessionRuntimeStore.getState().applySnapshot(snapshot({
      projectSlugs: ["proj", "other"],
      families: [
        { projectSlug: "proj", rootSessionId: "stale-root", activity: "running" },
        { projectSlug: "other", rootSessionId: "other-root", activity: "stopping" },
      ],
    }));

    sessionRuntimeStore.getState().applySnapshot(snapshot({
      projectSlugs: ["proj"],
      families: [
        { projectSlug: "proj", rootSessionId: "current-root", activity: "running" },
      ],
    }));

    expect(sessionRuntimeStore.getState().families).toEqual({
      [runtimeFamilyKey("proj", "current-root")]: {
        projectSlug: "proj",
        rootSessionId: "current-root",
        activity: "running",
      },
      [runtimeFamilyKey("other", "other-root")]: {
        projectSlug: "other",
        rootSessionId: "other-root",
        activity: "stopping",
      },
    });
  });

  test("realtime idle removes a sparse projection while non-idle changes upsert", () => {
    sessionRuntimeStore.getState().applySnapshot(snapshot({ projectSlugs: ["proj"], families: [] }));

    sessionRuntimeStore.getState().applyChange(change({ activity: "running" }));
    expect(sessionRuntimeStore.getState().activityFor("proj", "root-1")).toBe("running");

    sessionRuntimeStore.getState().applyChange(change({ activity: "stopping" }));
    expect(sessionRuntimeStore.getState().activityFor("proj", "root-1")).toBe("stopping");

    sessionRuntimeStore.getState().applyChange(change({ activity: "idle" }));
    expect(sessionRuntimeStore.getState().families).toEqual({});
    expect(sessionRuntimeStore.getState().activityFor("proj", "root-1")).toBe("idle");
  });

  test("change before snapshot is retained but does not initialize controls", () => {
    sessionRuntimeStore.getState().applyChange(change({ activity: "running" }));

    expect(sessionRuntimeStore.getState().families[runtimeFamilyKey("proj", "root-1")]?.activity).toBe("running");
    expect(sessionRuntimeStore.getState().isProjectInitialized("proj")).toBe(false);
    expect(sessionRuntimeStore.getState().activityFor("proj", "root-1")).toBeUndefined();
  });

  test("invalidating runtime snapshots disables controls without inventing idle", () => {
    sessionRuntimeStore.getState().applySnapshot(snapshot({
      projectSlugs: ["proj"],
      families: [{ projectSlug: "proj", rootSessionId: "root-1", activity: "running" }],
    }));

    sessionRuntimeStore.getState().invalidateSnapshots();

    expect(sessionRuntimeStore.getState().isProjectInitialized("proj")).toBe(false);
    expect(sessionRuntimeStore.getState().activityFor("proj", "root-1")).toBeUndefined();
  });

  test("a live family change cannot initialize a newly registered project without a snapshot", () => {
    sessionRuntimeStore.getState().applyChange(change({ activity: "running" }));

    expect(sessionRuntimeStore.getState().isProjectInitialized("proj")).toBe(false);
    expect(sessionRuntimeStore.getState().activityFor("proj", "root-1")).toBeUndefined();
  });

  test("removing a project clears its initialization and runtime families only", () => {
    sessionRuntimeStore.getState().applySnapshot(snapshot({
      projectSlugs: ["proj", "other"],
      families: [
        { projectSlug: "proj", rootSessionId: "root-1", activity: "running" },
        { projectSlug: "other", rootSessionId: "root-2", activity: "stopping" },
      ],
    }));

    sessionRuntimeStore.getState().removeProject("proj");

    expect(sessionRuntimeStore.getState().isProjectInitialized("proj")).toBe(false);
    expect(sessionRuntimeStore.getState().families).toEqual({
      [runtimeFamilyKey("other", "root-2")]: {
        projectSlug: "other",
        rootSessionId: "root-2",
        activity: "stopping",
      },
    });
  });
});

function snapshot(input: Pick<GlobalSSESessionRuntimeSnapshotEvent, "projectSlugs" | "families">): GlobalSSESessionRuntimeSnapshotEvent {
  return { type: "session.runtime.snapshot", createdAt: 1, ...input };
}

function change(input: Pick<GlobalSSESessionRuntimeChangedEvent, "activity">): GlobalSSESessionRuntimeChangedEvent {
  return {
    type: "session.runtime_changed",
    projectSlug: "proj",
    rootSessionId: "root-1",
    createdAt: 1,
    ...input,
  };
}
