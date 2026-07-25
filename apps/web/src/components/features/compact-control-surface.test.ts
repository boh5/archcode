import { describe, expect, test } from "bun:test";

const webSource = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return await Bun.file(new URL(path, webSource)).text();
}

describe("compact icon control contract", () => {
  test("Todo progress and Toast dismiss actions use the shared 28px accessible control", async () => {
    const todo = await source("components/features/TodoProgressButton.tsx");
    const toast = await source("components/composite/Toast.tsx");

    expect(todo).toContain('<IconAction label="Close todo progress"');
    expect(toast).toContain('<IconAction');
    expect(toast).toContain('label="Dismiss"');
    expect(todo).toContain("rounded-lg border border-border-default bg-bg-overlay p-3 shadow-md");
  });

  test("Settings retry and ErrorBoundary reload use the standard 32px control", async () => {
    const settings = await source("components/features/SettingsDialog.tsx");
    const boundary = await source("components/composite/ErrorBoundary.tsx");
    const session = await source("routes/session.tsx");

    expect(settings).toContain('className="mt-3 h-8 rounded-sm');
    expect(boundary).toContain('className="mt-2 h-8 cursor-pointer rounded-sm');
    expect(session).toContain('className="h-8 rounded-sm border border-border-default bg-bg-elevated px-3 text-[12px] font-medium leading-4');
  });

  test("Model Picker keeps Popover radius separate from field and menu-control radius", async () => {
    const picker = await source("components/features/ModelPicker.tsx");
    expect(picker).toContain("rounded-lg border border-border-default bg-bg-overlay");
    expect(picker).toContain("h-8 w-full rounded-sm border border-border-control");
  });

  test("Composer owns overlay Menu styling and keeps Send/Stop on the control grammar", async () => {
    const chat = await source("components/features/ChatInput.tsx");
    expect(chat).toContain("rounded-lg border border-border-default bg-bg-overlay p-1 shadow-md");
    expect(chat).toContain("text-[12px] leading-4 text-text-tertiary");
    expect(chat).toContain("h-8 w-8 items-center justify-center rounded-sm transition-colors");
  });

  test("task-critical metadata uses the tertiary foreground", async () => {
    const header = await source("components/features/ChatHeader.tsx");
    const sidebar = await source("components/features/Sidebar.tsx");

    expect(header).toContain("text-[11px] text-text-tertiary");
    expect(sidebar.match(/text-\[11px\] text-text-tertiary/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("Compression uses the nested Execution surface without fake card hover", async () => {
    const compression = await source("components/composite/CompressionBlock.tsx");
    expect(compression).toContain('overflow-hidden rounded-md border border-border-subtle bg-bg-elevated');
    expect(compression).toContain('bg-transparent px-3 py-2 text-left');
    expect(compression).toContain('active: "Active"');
  });

  test("Work stays flat while Delegation retains its nested surface", async () => {
    const workstream = await source("components/composite/ExecutionWorkstream.tsx");
    const delegation = await source("components/composite/DelegationCard.tsx");
    expect(workstream).toContain("work-summary-control flex min-h-8");
    expect(workstream).toContain("hover:bg-bg-hover");
    expect(delegation).toContain("rounded-md border border-border-subtle bg-bg-elevated");
    expect(delegation).toContain("border-b border-border-subtle bg-transparent");
  });

  test("HITL overlays and Tooltips use their exclusive ownership tokens", async () => {
    const bell = await source("components/features/HitlBell.tsx");
    const iconAction = await source("components/primitives/IconAction.tsx");
    const projectBar = await source("components/features/ProjectBar.tsx");
    expect(bell).toContain("rounded-md border border-border-strong bg-bg-overlay p-3 shadow-lg");
    expect(bell).toContain("rounded-lg border border-border-default bg-bg-overlay p-3 shadow-md");
    expect(iconAction).toContain('role="tooltip"');
    expect(iconAction).toContain("rounded-lg border border-border-default bg-bg-overlay");
    expect(projectBar.match(/role="tooltip"/g)?.length).toBe(2);
    expect(projectBar.match(/rounded-lg border border-border-default bg-bg-overlay/g)?.length).toBe(2);
  });

  test("Project Todo and Goal editors use control radius and 32px actions", async () => {
    const todos = await source("routes/project-todos.tsx");
    const goal = await source("components/features/SessionGoalSummaryRow.tsx");
    expect(todos).toContain('aria-label="New Todo"');
    expect(goal).toContain("h-8 rounded-sm border px-3 text-[12px]");
  });
});
