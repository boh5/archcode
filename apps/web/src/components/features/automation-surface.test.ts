import { describe, expect, test } from "bun:test";

const webSource = `${import.meta.dir}/../../`;

async function source(path: string): Promise<string> {
  return await Bun.file(`${webSource}${path}`).text();
}

describe("Automation navigation and detail actions", () => {
  test("Sidebar routes Automation navigation and creation through the Automation surface", async () => {
    const sidebar = await source("components/features/Sidebar.tsx");
    expect(sidebar).toContain('"automations"');
    expect(sidebar).toContain('/automations/${clickedAutomationId}');
    expect(sidebar).toContain('automation-create');
    expect(sidebar).not.toContain("/loops");
  });

  test("detail exposes only Automation controls and Session-linked invocation history", async () => {
    const detail = await source("routes/automation-detail.tsx");
    expect(detail).toContain("Run now");
    expect(detail).toContain("Pause");
    expect(detail).toContain("Resume");
    expect(detail).toContain("Invocation History");
    expect(detail).toContain("Open Session");
    expect(detail).toContain('searchParams.get("invocation")');
    expect(detail).toContain("scrollIntoView");
    expect(detail).not.toContain("Global kill");
    expect(detail).not.toContain("Budget");
    expect(detail).not.toContain("collision");
  });

  test("Automation creation still starts its conversation Skill", async () => {
    const automations = await source("routes/automations.tsx");
    const sidebar = await source("components/features/Sidebar.tsx");
    expect(automations).toContain('content: "/skill use automation-create"');
    expect(sidebar).toContain('content: `/skill use ${skill}`');
    expect(automations).toContain("usePostMessage");
    expect(sidebar).toContain("usePostMessage");
    expect(automations).not.toContain("AutomationDialog");
    expect(sidebar).not.toContain("goal-create");
  });

  test("Automation retains creation provenance while Goal is Session-owned", async () => {
    const automation = await source("routes/automation-detail.tsx");
    const context = await source("components/features/context-inspector/SessionContextDetails.tsx");
    expect(automation).toContain("Created from");
    expect(context).toContain("Created here");
    expect(context).not.toContain("Executing Goal");
  });
});
