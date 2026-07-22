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

  test("Automation enablement uses static domain status glyphs", async () => {
    const sidebar = await source("components/features/Sidebar.tsx");
    const list = await source("routes/automations.tsx");
    const detail = await source("routes/automation-detail.tsx");
    expect(sidebar).toContain("automationVisualKind");
    expect(list).toContain("automationVisualKind(automation.status)");
    expect(detail).toContain("automationVisualKind(automation.status)");
    expect(sidebar).not.toContain("AUTOMATION_STATUS_DOT_COLORS");
    expect(sidebar).not.toContain("bg-success shadow");
  });

  test("detail header uses the locked control language", async () => {
    const detail = await source("routes/automation-detail.tsx");
    expect(detail).toContain('<IconAction label="Edit automation"');
    expect(detail).toContain('<IconAction danger label="Delete automation"');
    expect(detail).toContain('aria-label="Back to automations"');
    expect(detail).toContain('text-[16px] font-semibold leading-[22px]');
    expect(detail).toContain("min-[640px]:flex-nowrap");
    expect(detail).toContain('className="flex w-full basis-full shrink-0 items-center justify-end gap-2 min-[640px]:w-auto min-[640px]:basis-auto"');
    expect(detail).toContain('className="inline-flex h-8 shrink-0 items-center');
    expect(detail).not.toContain('title="Edit Automation"');
    expect(detail).not.toContain('title="Delete Automation"');
    expect(detail).not.toContain("px-3 py-2 text-sm");
  });

  test("list header and creation controls use the locked page and control scale", async () => {
    const list = await source("routes/automations.tsx");
    expect(list).toContain('<h1 className="text-[16px] font-semibold leading-[22px]">Automations</h1>');
    expect(list.match(/inline-flex h-8 items-center/g)?.length).toBe(2);
    expect(list).not.toContain("px-3 py-2 text-sm");
    expect(list).toContain('text-[11px] leading-4 text-text-tertiary');
    expect(list).not.toContain('mt-1 text-xs text-text-muted');
  });

  test("detail keeps schedule and due metadata readable", async () => {
    const detail = await source("routes/automation-detail.tsx");
    expect(detail.match(/text-\[11px\] leading-4 text-text-tertiary/g)?.length).toBeGreaterThanOrEqual(2);
    expect(detail).not.toContain('<dt className="text-text-muted">');
    expect(detail).not.toContain('<span className="ml-2 text-text-muted">due');
  });
});
