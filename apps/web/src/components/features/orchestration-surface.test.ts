import { describe, expect, test } from "bun:test";
import { deriveSidebarTabFromPath } from "./Sidebar";
import {
  buildInspectorChildStatusMap,
  resolveInspectorAgentStatus,
} from "./context-inspector/SessionAgentsInspector";

const webSource = `${import.meta.dir}/../../`;

async function source(path: string): Promise<string> {
  return await Bun.file(`${webSource}${path}`).text();
}

describe("orchestration workbench surface", () => {
  test("places Project Dashboard before Todos in the project sidebar", async () => {
    const sidebar = await source("components/features/Sidebar.tsx");
    const dashboardPosition = sidebar.indexOf('label="Project Dashboard"');
    const todosPosition = sidebar.indexOf('label="Todos"');

    expect(dashboardPosition).toBeGreaterThan(-1);
    expect(todosPosition).toBeGreaterThan(-1);
    expect(dashboardPosition).toBeLessThan(todosPosition);
  });

  test("keeps the selected list tab when the route moves to Project Dashboard or Todos", () => {
    expect(deriveSidebarTabFromPath("/projects/demo/sessions/session-1")).toBe("sessions");
    expect(deriveSidebarTabFromPath("/projects/demo/automations/automation-1")).toBe("automations");
    expect(deriveSidebarTabFromPath("/projects/demo")).toBeNull();
    expect(deriveSidebarTabFromPath("/projects/demo/todos")).toBeNull();
  });

  test("renders the Agent tree as indented text without appearance UI", async () => {
    const inspector = await source("components/features/context-inspector/SessionAgentsInspector.tsx");

    expect(inspector).toContain("agent.depth * 16");
    expect(inspector).toContain("agent.profile");
    expect(inspector).toContain("displayName");
    expect(inspector).toContain("data-agent-status");
    expect(inspector).toContain("buildAgentFocusSearch");
    expect(inspector).not.toContain("resolveAgentAppearance");
    expect(inspector).not.toContain("appearance.initial");
    expect(inspector).not.toContain("agent-avatar");
  });

  test("uses only authoritative runtime and child-link statuses in the Agent tree", () => {
    expect(resolveInspectorAgentStatus("running").label).toBe("Running");
    expect(resolveInspectorAgentStatus("running").kind).toBe("running");
    expect(resolveInspectorAgentStatus("idle").label).toBe("Idle");
    expect(resolveInspectorAgentStatus("stopping")).toMatchObject({ label: "Stopping", kind: "running", tone: "warning" });
    expect(resolveInspectorAgentStatus(undefined, "waiting_for_human").label).toBe("Needs you");
    expect(resolveInspectorAgentStatus(undefined, "waiting_for_human").kind).toBe("needs_you");
    expect(resolveInspectorAgentStatus(undefined, "cancelled").label).toBe("Stopped");
    expect(resolveInspectorAgentStatus(undefined, "cancelled").kind).toBe("stopped");
    expect(resolveInspectorAgentStatus(undefined, "cancelled").detail).toBe("Cancelled");
    expect(resolveInspectorAgentStatus(undefined, "completed").label).toBe("Completed");
    expect(resolveInspectorAgentStatus(undefined).label).toBe("Status unavailable");
  });

  test("hard-cuts legacy state dots, pulse, raw Goal badges, and Todo spinners", async () => {
    const [sidebar, header, goal, composer, todo] = await Promise.all([
      source("components/features/Sidebar.tsx"),
      source("components/features/ChatHeader.tsx"),
      source("components/features/SessionGoalProgressRow.tsx"),
      source("components/features/ChatInput.tsx"),
      source("components/features/TodoProgressButton.tsx"),
    ]);
    expect(sidebar).not.toContain("STATUS_DOT_COLORS");
    expect(sidebar).not.toContain("AUTOMATION_STATUS_DOT_COLORS");
    expect(sidebar).not.toContain("animate-pulse");
    expect(sidebar).not.toContain("Goal ·");
    expect(header).not.toContain("EXECUTION_STATUS_CLASS");
    expect(header).not.toContain("Goal ·");
    expect(goal).not.toContain("◎");
    expect(goal).not.toContain("Pursuing goal");
    expect(goal).toContain("IconAction");
    expect(composer).not.toContain("dotClass");
    expect(todo).not.toContain("STATE_CLASS");
    expect(todo).not.toContain("animate-spin");
  });

  test("resolves nested child status from each authoritative parent Session link", () => {
    const base = {
      parentToolCallId: "delegate",
      toolName: "delegate",
      childAgentName: "build",
      childProfile: "deep",
      childSkillNames: [] as string[],
      title: "Delegated work",
      depth: 1,
      background: false,
      createdAt: 1,
    } as const;
    const statuses = buildInspectorChildStatusMap(
      [{
        ...base,
        parentSessionId: "root",
        childSessionId: "child",
        status: "completed",
      }],
      [{
        sessionId: "child",
        childSessionLinks: [{
          ...base,
          parentSessionId: "child",
          childSessionId: "grandchild",
          childAgentName: "explore",
          childProfile: "fast",
          status: "waiting_for_human",
        }],
      }],
    );

    expect(statuses.get("child")).toBe("completed");
    expect(statuses.get("grandchild")).toBe("waiting_for_human");
  });
});
