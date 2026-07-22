import { describe, expect, test } from "bun:test";

const webSource = `${import.meta.dir}/../../`;

async function source(path: string): Promise<string> {
  return await Bun.file(`${webSource}${path}`).text();
}

describe("compact icon control hard cut", () => {
  test("Todo progress and Toast dismiss actions use the shared 28px accessible control", async () => {
    const todo = await source("components/features/TodoProgressButton.tsx");
    const toast = await source("components/composite/Toast.tsx");

    expect(todo).toContain('<IconAction label="Close todo progress"');
    expect(toast).toContain('<IconAction');
    expect(toast).toContain('label="Dismiss"');
    expect(todo).toContain("rounded-lg border border-border-default bg-bg-overlay p-3 shadow-md");
    expect(todo).not.toContain("rounded-md border border-border-default bg-bg-elevated p-3 shadow-lg");
    expect(todo).not.toContain('<button type="button" aria-label="Close todo progress"');
    expect(toast).not.toContain('<button');
  });

  test("Settings retry and ErrorBoundary reload use the standard 32px control", async () => {
    const settings = await source("components/features/SettingsDialog.tsx");
    const boundary = await source("components/composite/ErrorBoundary.tsx");
    const session = await source("routes/session.tsx");

    expect(settings).toContain('className="mt-3 h-8 rounded-sm');
    expect(boundary).toContain('className="mt-2 h-8 cursor-pointer rounded-sm');
    expect(session).toContain('className="h-8 rounded-sm border border-border-default bg-bg-elevated px-3 text-[12px] font-medium leading-4');
    expect(settings).not.toContain("<button type=\"button\" onClick={() => { void reload(); }}>Retry</button>");
    expect(boundary).not.toContain("px-4 py-2 rounded-md");
    expect(session).not.toContain("rounded-md border border-border-default bg-bg-elevated px-3 py-2");
  });

  test("Model Picker keeps Popover radius separate from field and menu-control radius", async () => {
    const picker = await source("components/features/ModelPicker.tsx");
    expect(picker).toContain("rounded-lg border border-border-default bg-bg-overlay");
    expect(picker).toContain("h-8 w-full rounded-sm border border-border-control");
    expect(picker).not.toContain("items-center gap-2 rounded-md px-3 py-2");
    expect(picker).not.toContain("w-full rounded-md px-3 py-2");
  });

  test("Composer owns overlay Menu styling and keeps Send/Stop on the control grammar", async () => {
    const chat = await source("components/features/ChatInput.tsx");
    expect(chat).toContain("rounded-lg border border-border-default bg-bg-overlay p-1 shadow-md");
    expect(chat).toContain("text-[12px] leading-4 text-text-tertiary");
    expect(chat).toContain("h-8 w-8 items-center justify-center rounded-sm transition-colors");
    expect(chat).not.toContain("bg-bg-elevated p-1 shadow-md");
    expect(chat).not.toContain("active:scale-95");
    expect(chat).not.toContain("transition-[background-color,color,transform]");
  });

  test("task-critical metadata never uses the decorative muted foreground", async () => {
    const header = await source("components/features/ChatHeader.tsx");
    const sidebar = await source("components/features/Sidebar.tsx");
    const queue = await source("components/features/ComposerQueueList.tsx");
    const todo = await source("components/features/TodoProgressButton.tsx");
    const picker = await source("components/features/ModelPicker.tsx");

    expect(header).toContain("text-[11px] text-text-tertiary");
    expect(sidebar.match(/text-\[11px\] text-text-tertiary/g)?.length).toBeGreaterThanOrEqual(2);
    expect(queue).not.toContain("truncate text-[11px] text-text-muted max-[560px]:max-w-16");
    expect(todo).not.toContain('aria-live="polite" className="mt-1 text-[11px] text-text-muted"');
    expect(picker).not.toContain('<span className="text-text-muted">Running with</span>');
    expect(picker).not.toContain('<span className="text-text-muted">Next</span>');
  });

  test("Compression uses the nested Execution surface without fake card hover", async () => {
    const compression = await source("components/composite/CompressionBlock.tsx");
    expect(compression).toContain('overflow-hidden rounded-md border border-border-subtle bg-bg-elevated');
    expect(compression).toContain('bg-transparent px-3 py-2 text-left');
    expect(compression).not.toContain("hover:border-border-strong");
    expect(compression).not.toContain("bg-bg-surface border border-border-default rounded-lg");
    expect(compression).toContain('active: "Active"');
  });

  test("persistent Execution and Delegation cards use card radius and nested surfaces", async () => {
    const workstream = await source("components/composite/ExecutionWorkstream.tsx");
    const delegation = await source("components/composite/DelegationCard.tsx");
    expect(workstream).not.toContain("rounded-lg");
    expect(workstream).toContain("rounded-md border border-border-subtle bg-bg-elevated");
    expect(delegation).toContain("rounded-md border border-border-subtle bg-bg-elevated");
    expect(delegation).toContain("border-b border-border-subtle bg-transparent");
    expect(delegation).not.toContain("border-border-default bg-bg-surface");
  });

  test("HITL overlays, Tooltips, and Composer shadow use their exclusive ownership tokens", async () => {
    const bell = await source("components/features/HitlBell.tsx");
    const dock = await source("components/features/SessionComposerDock.tsx");
    const iconAction = await source("components/primitives/IconAction.tsx");
    const projectBar = await source("components/features/ProjectBar.tsx");
    expect(bell).toContain("rounded-xl border border-border-strong bg-bg-overlay p-3 shadow-lg");
    expect(bell).toContain("rounded-lg border border-border-default bg-bg-overlay p-3 shadow-md");
    expect(bell).not.toContain("shadow-xl");
    expect(dock).not.toContain("shadow-sm");
    expect(iconAction).toContain('role="tooltip"');
    expect(iconAction).toContain("rounded-lg border border-border-default bg-bg-overlay");
    expect(projectBar.match(/role="tooltip"/g)?.length).toBe(2);
    expect(projectBar.match(/rounded-lg border border-border-default bg-bg-overlay/g)?.length).toBe(2);
  });

  test("Project Todo and Goal editors use control radius and 32px actions", async () => {
    const todos = await source("routes/project-todos.tsx");
    const goal = await source("components/features/SessionGoalProgressRow.tsx");
    expect(todos).toContain('aria-label="New Todo"');
    expect(todos).not.toContain('aria-label="New Todo" onClick={handleCreate} disabled={createTodo.isPending} className="inline-flex h-8 shrink-0 items-center gap-2 rounded-md');
    expect(todos).not.toContain("gap-2 rounded-md border px-3 py-2 text-[12px]");
    expect(goal).toContain("h-8 rounded-sm border px-3 text-[12px]");
    expect(goal).not.toContain("className={`rounded-md border px-3 py-2");
  });

  test("named task-critical metadata and actionable icon controls stay above muted contrast", async () => {
    const workstream = await source("components/composite/ExecutionWorkstream.tsx");
    const tool = await source("components/composite/ToolCard.tsx");
    const viewer = await source("components/composite/ToolOutputViewer.tsx");
    const closeProject = await source("components/features/CloseProjectDialog.tsx");
    const automation = await source("components/features/EditAutomationDialog.tsx");
    const bell = await source("components/features/HitlBell.tsx");
    const sidebar = await source("components/features/Sidebar.tsx");

    expect(workstream).not.toContain('execution.record.error && <span className="mt-1 block text-text-muted"');
    expect(tool).not.toContain('text-[11px] text-text-muted">expires');
    expect(viewer).not.toContain('text-[11px] text-text-muted">Viewer limit reached');
    expect(closeProject).not.toContain("text-[12px] text-text-muted truncate");
    expect(automation).not.toContain("leading-4 text-text-muted\">{description}");
    expect(bell).not.toContain("rounded-sm text-text-muted");
    expect(sidebar).not.toContain("h-7 w-7 items-center justify-center rounded-sm text-text-muted");
  });
});
