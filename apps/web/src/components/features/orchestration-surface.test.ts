import { describe, expect, test } from "bun:test";
import {
  resolveInspectorAgentStatus,
} from "./context-inspector/SessionAgentsInspector";

const webSource = `${import.meta.dir}/../../`;

async function source(path: string): Promise<string> {
  return await Bun.file(`${webSource}${path}`).text();
}

describe("orchestration workbench surface", () => {
  test("renders the Agent tree with named role identity and one quiet role mark", async () => {
    const inspector = await source("components/features/context-inspector/SessionAgentsInspector.tsx");

    expect(inspector).toContain("agent.depth * 12");
    expect(inspector).toContain("agent.profile");
    expect(inspector).toContain("displayName");
    expect(inspector).toContain("data-agent-role-icon");
    expect(inspector).toContain("data-agent-status");
    expect(inspector).toContain("grid-cols-[25px_minmax(0,1fr)_auto]");
    expect(inspector).toContain("h-[25px] w-[25px]");
    expect(inspector).toContain("buildAgentFocusSearch");
  });

  test("keeps Changes and Context as compact flat inspector rows", async () => {
    const changes = await source("components/features/context-inspector/SessionChangesInspector.tsx");
    const context = await source("components/features/context-inspector/SessionContextDetails.tsx");

    expect(changes).toContain("min-h-10");
    expect(changes).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(changes).toContain("grid-cols-[16px_minmax(0,1fr)_auto]");
    expect(changes).toContain('data-testid="context-change-summary"');
    expect(changes).toContain('font-mono text-[11px] font-semibold');
    expect(context).toContain('data-testid="context-property-list"');
    expect(context).toContain('["Goal"');
    expect(context).toContain('["Execution"');
    expect(context).toContain('["Profile"');
    expect(context).toContain('["Working dir"');
  });

  test("uses only authoritative family activity and projected link statuses in the Agent tree", () => {
    expect(resolveInspectorAgentStatus("running").label).toBe("Running");
    expect(resolveInspectorAgentStatus("running").kind).toBe("running");
    expect(resolveInspectorAgentStatus("idle").label).toBe("Idle");
    expect(resolveInspectorAgentStatus("stopping")).toMatchObject({ label: "Stopping", kind: "running", tone: "warning" });
    expect(resolveInspectorAgentStatus(undefined, "waiting_for_human").label).toBe("Paused");
    expect(resolveInspectorAgentStatus(undefined, "waiting_for_human").kind).toBe("pending");
    expect(resolveInspectorAgentStatus("waiting_for_human", undefined, undefined, "Permission")).toMatchObject({ label: "Permission", kind: "needs_you" });
    expect(resolveInspectorAgentStatus("waiting_for_human", undefined, undefined, "Question")).toMatchObject({ label: "Question", kind: "needs_you" });
    expect(resolveInspectorAgentStatus(undefined, "cancelled").label).toBe("Stopped");
    expect(resolveInspectorAgentStatus(undefined, "cancelled").kind).toBe("stopped");
    expect(resolveInspectorAgentStatus(undefined, "cancelled").detail).toBe("Cancelled");
    expect(resolveInspectorAgentStatus(undefined, "completed").label).toBe("Completed");
    expect(resolveInspectorAgentStatus(undefined, undefined, "suspended")).toMatchObject({ label: "Paused", kind: "pending" });
    expect(resolveInspectorAgentStatus("idle", undefined, "completed")).toMatchObject({ label: "Completed", kind: "completed" });
    expect(resolveInspectorAgentStatus("running", undefined, "completed")).toMatchObject({ label: "Running", kind: "running" });
    expect(resolveInspectorAgentStatus(undefined).label).toBe("Status unavailable");
  });
});
