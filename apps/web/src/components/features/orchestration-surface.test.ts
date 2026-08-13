import { describe, expect, test } from "bun:test";
import {
  buildInspectorChildStatusMap,
  resolveInspectorAgentStatus,
} from "./context-inspector/SessionAgentsInspector";

const webSource = `${import.meta.dir}/../../`;

async function source(path: string): Promise<string> {
  return await Bun.file(`${webSource}${path}`).text();
}

describe("orchestration workbench surface", () => {
  test("renders the Agent tree with named role identity and one quiet role mark", async () => {
    const inspector = await source("components/features/context-inspector/SessionAgentsInspector.tsx");

    expect(inspector).toContain("agent.depth * 14");
    expect(inspector).toContain("agent.profile");
    expect(inspector).toContain("displayName");
    expect(inspector).not.toContain("AGENT_ROLE_ICON");
    expect(inspector).toContain("data-agent-role-icon");
    expect(inspector).toContain("data-agent-status");
    expect(inspector).toContain("grid-cols-[22px_minmax(0,1fr)_auto]");
    expect(inspector).toContain("h-[22px] w-[22px]");
    expect(inspector).toContain("buildAgentFocusSearch");
    expect(inspector).not.toContain("Skills:");
  });

  test("keeps Changes and Context as compact flat inspector rows", async () => {
    const changes = await source("components/features/context-inspector/SessionChangesInspector.tsx");
    const context = await source("components/features/context-inspector/SessionContextDetails.tsx");

    expect(changes).toContain("min-h-8");
    expect(changes).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(changes).toContain("grid-cols-[14px_minmax(0,1fr)_auto]");
    expect(context).toContain('data-testid="context-property-list"');
    expect(context).toContain('["Goal"');
    expect(context).toContain('["Execution"');
    expect(context).toContain('["Working dir"');
  });

  test("uses only authoritative runtime and child-link statuses in the Agent tree", () => {
    expect(resolveInspectorAgentStatus("running").label).toBe("Running");
    expect(resolveInspectorAgentStatus("running").kind).toBe("running");
    expect(resolveInspectorAgentStatus("idle").label).toBe("Idle");
    expect(resolveInspectorAgentStatus("stopping")).toMatchObject({ label: "Stopping", kind: "running", tone: "warning" });
    expect(resolveInspectorAgentStatus(undefined, "waiting_for_human").label).toBe("Paused");
    expect(resolveInspectorAgentStatus(undefined, "waiting_for_human").kind).toBe("pending");
    expect(resolveInspectorAgentStatus("waiting_for_human", undefined, "Permission")).toMatchObject({ label: "Permission", kind: "needs_you" });
    expect(resolveInspectorAgentStatus("waiting_for_human", undefined, "Question")).toMatchObject({ label: "Question", kind: "needs_you" });
    expect(resolveInspectorAgentStatus(undefined, "cancelled").label).toBe("Stopped");
    expect(resolveInspectorAgentStatus(undefined, "cancelled").kind).toBe("stopped");
    expect(resolveInspectorAgentStatus(undefined, "cancelled").detail).toBe("Cancelled");
    expect(resolveInspectorAgentStatus(undefined, "completed").label).toBe("Completed");
    expect(resolveInspectorAgentStatus(undefined).label).toBe("Status unavailable");
  });
  test("resolves nested child status from each authoritative parent Session link", () => {
    const base = {
      parentToolCallId: "delegate",
      toolName: "delegate",
      childExecutionId: "child-execution",
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
