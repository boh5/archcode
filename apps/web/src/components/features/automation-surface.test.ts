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
    expect(sidebar).toContain("AutomationDialog");
    expect(sidebar).not.toContain("/loops");
  });

  test("detail exposes only Automation controls and Session-linked invocation history", async () => {
    const detail = await source("routes/automation-detail.tsx");
    expect(detail).toContain("Run now");
    expect(detail).toContain("Pause");
    expect(detail).toContain("Resume");
    expect(detail).toContain("Invocation History");
    expect(detail).toContain("Open Session");
    expect(detail).not.toContain("Global kill");
    expect(detail).not.toContain("Budget");
    expect(detail).not.toContain("collision");
  });
});
