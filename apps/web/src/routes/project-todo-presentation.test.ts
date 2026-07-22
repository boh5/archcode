import { describe, expect, test } from "bun:test";
import { Ban, Calendar, CircleDashed, CirclePause, Clock3, LoaderCircle } from "lucide-react";
import {
  PROJECT_TODO_LANE_PRESENTATIONS,
  presentProjectTodoAssociation,
  presentProjectTodoCard,
} from "./project-todo-presentation";

describe("Project Todo presentation", () => {
  test("uses the locked card presentation precedence without changing lifecycle facts", () => {
    expect(presentProjectTodoCard({ status: "idea", hasActivation: false })).toMatchObject({ label: "Idea", tone: "brand" });
    expect(presentProjectTodoCard({ status: "ready", hasActivation: false })).toMatchObject({ label: "Ready", tone: "info" });
    expect(presentProjectTodoCard({ status: "ready", hasActivation: true })).toMatchObject({ label: "In Progress", tone: "info" });
    expect(presentProjectTodoCard({ status: "done", hasActivation: true })).toMatchObject({ label: "Done", tone: "success" });
    expect(presentProjectTodoCard({ status: "rejected", hasActivation: true })).toMatchObject({ label: "Rejected", tone: "error" });
    expect(presentProjectTodoCard({ status: "done", archivedAt: 1, hasActivation: true })).toMatchObject({ label: "Archived", tone: "neutral" });
  });

  test("keeps all four workflow lane metadata in domain order", () => {
    expect(Object.keys(PROJECT_TODO_LANE_PRESENTATIONS)).toEqual(["idea", "ready", "in_progress", "done"]);
    expect(PROJECT_TODO_LANE_PRESENTATIONS.idea).toMatchObject({ title: "Ideas", tone: "brand" });
    expect(PROJECT_TODO_LANE_PRESENTATIONS.in_progress).toMatchObject({ title: "In Progress", tone: "info" });
  });

  test("permits association motion only for real query or Session-family activity", () => {
    expect(presentProjectTodoAssociation({
      resourceLoading: true,
      runtimeInitialized: true,
      resourceAvailable: false,
    })).toMatchObject({ Icon: Clock3, tone: "neutral", motion: "none" });
    expect(presentProjectTodoAssociation({
      resourceLoading: true,
      runtimeInitialized: false,
      resourceId: "automation-1",
    })).toMatchObject({ tone: "neutral", motion: "loop" });
    expect(presentProjectTodoAssociation({
      resourceLoading: true,
      runtimeInitialized: true,
      resourceId: "session-1",
      resourceAvailable: true,
      sessionActivity: "running",
    })).toMatchObject({ Icon: LoaderCircle, tone: "neutral", motion: "loop" });
    expect(presentProjectTodoAssociation({
      resourceLoading: false,
      runtimeInitialized: true,
      sessionActivity: "running",
    })).toMatchObject({ tone: "info", motion: "loop", Icon: "activity-arc" });
    expect(presentProjectTodoAssociation({
      resourceLoading: false,
      runtimeInitialized: true,
      sessionActivity: "stopping",
    })).toMatchObject({ tone: "warning", motion: "loop", Icon: "activity-arc" });
    expect(presentProjectTodoAssociation({
      resourceLoading: false,
      runtimeInitialized: true,
      sessionActivity: "idle",
    })).toMatchObject({ tone: "neutral", motion: "none" });
    expect(presentProjectTodoAssociation({
      resourceLoading: false,
      runtimeInitialized: false,
      resourceId: "session-1",
    })).toMatchObject({ Icon: CircleDashed, tone: "neutral", motion: "none" });
    expect(presentProjectTodoAssociation({
      resourceLoading: false,
      runtimeInitialized: true,
    })).toMatchObject({ tone: "neutral", motion: "none" });
    expect(presentProjectTodoAssociation({
      resourceLoading: false,
      runtimeInitialized: true,
      resourceId: "automation-1",
      resourceAvailable: true,
      automationStatus: "active",
    })).toMatchObject({ Icon: Calendar, tone: "info", motion: "none" });
    expect(presentProjectTodoAssociation({
      resourceLoading: false,
      runtimeInitialized: true,
      resourceId: "automation-1",
      resourceAvailable: true,
      automationStatus: "paused",
    })).toMatchObject({ Icon: CirclePause, tone: "warning", motion: "none" });
    expect(presentProjectTodoAssociation({
      resourceLoading: false,
      runtimeInitialized: true,
      resourceId: "automation-1",
      resourceAvailable: true,
      automationStatus: "disabled",
    })).toMatchObject({ Icon: Ban, tone: "neutral", motion: "none" });
  });
});
