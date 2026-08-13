import { describe, expect, test } from "bun:test";

const webSource = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return await Bun.file(new URL(path, webSource)).text();
}

describe("compact icon control contract", () => {
  test("Todo progress and Toast dismiss actions use the shared 32px accessible control", async () => {
    const todo = await source("components/features/TodoProgressButton.tsx");
    const toast = await source("components/composite/Toast.tsx");

    expect(todo).toContain('<IconAction label="Close todo progress"');
    expect(toast).toContain('<IconAction');
    expect(toast).toContain('label="Dismiss"');
    const iconAction = await source("components/primitives/IconAction.tsx");
    expect(iconAction).toContain("h-8 w-8");
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

  test("Model Picker keeps the shared Popover surface behind one quiet trigger", async () => {
    const picker = await source("components/features/ModelPicker.tsx");
    expect(picker).toContain("rounded-[12px] border border-border-default bg-bg-overlay p-1.5");
    expect(picker).toContain('className="relative z-[5] flex min-w-0 max-w-[min(240px,42vw)] items-center"');
    expect(picker.match(/data-testid="model-picker-trigger"/g)).toHaveLength(1);
    expect(picker).toContain('aria-label="Choose model and effort"');
    expect(picker).toContain("transition-[background-color,color]");
  });

  test("Composer owns overlay Menu styling and keeps Send/Stop on the control grammar", async () => {
    const chat = await source("components/features/ChatInput.tsx");
    expect(chat).toContain("rounded-lg border border-border-default bg-bg-overlay p-1 shadow-md");
    expect(chat).toContain("text-[12px] leading-4 text-text-tertiary");
    expect(chat).toContain("h-8 w-8 items-center justify-center rounded-sm transition-colors");
  });

  test("task-critical header metadata uses the tertiary foreground", async () => {
    const header = await source("components/features/ChatHeader.tsx");

    expect(header).toContain("text-[12px] leading-[1.3] text-text-tertiary");
  });

  test("Compression uses the nested Execution surface without fake card hover", async () => {
    const compression = await source("components/composite/CompressionBlock.tsx");
    expect(compression).toContain('overflow-hidden rounded-[6px] border border-border-default bg-bg-elevated');
    expect(compression).toContain('bg-transparent px-2.5 py-2 text-left');
    expect(compression).toContain('active: "Active"');
  });

  test("Work stays flat while Delegation retains its nested surface", async () => {
    const workstream = await source("components/composite/ExecutionWorkstream.tsx");
    const delegation = await source("components/composite/DelegationCard.tsx");
    expect(workstream).toContain("work-summary-control group flex min-h-9");
    expect(workstream).toContain('data-testid={`work-divider-${segment.id}`}');
    expect(workstream).not.toContain("work-summary-control relative flex min-h-8");
    expect(delegation).toContain("rounded-[6px] border border-[color:color-mix(in_srgb,var(--brand)_34%,var(--border-default))] bg-bg-elevated");
    expect(delegation).toContain("border-b border-border-subtle bg-transparent");
  });

  test("the transcript and Composer share one visible thread column", async () => {
    const workstream = await source("components/composite/ExecutionWorkstream.tsx");
    const composer = await source("components/features/SessionComposerDock.tsx");
    const rail = await source("components/primitives/ConversationRail.tsx");
    const markdown = await source("components/primitives/MarkdownContent.css");

    expect(rail).toContain("export function SessionThreadColumn");
    expect(rail).toContain("mx-auto w-full max-w-[852px] min-w-0");
    expect(rail).toContain('WORK_ACTIVITY_LANE_CLASS = "w-full min-w-0"');
    expect(rail).toContain('WORK_ACTIVITY_CHILD_LANE_CLASS = "w-full min-w-0"');
    expect(rail).toContain('WORK_ACTIVITY_NESTED_LANE_CLASS = "w-full min-w-0"');
    expect(workstream).toContain('data-testid="execution-thread-column"');
    expect(composer).toContain('data-testid="composer-thread-column"');
    expect(composer).toContain('className="flex min-h-0 max-h-full flex-col gap-2.5 !max-w-[848px]"');
    expect(composer).toContain('data-testid="composer-priority-stack"');
    expect(composer).toContain("max-h-[min(48dvh,520px)]");
    expect(composer).toContain("!max-w-[900px] !px-3");
    expect(composer).toContain("min-[761px]:!px-[26px]");
    expect(workstream).not.toContain("CONVERSATION_TURN_LANE_CLASS");
    expect(workstream).not.toContain("absolute -left-4 top-1/2");
    expect(workstream).toContain('scrollbarGutter: "stable"');
    expect(workstream).toContain('const SESSION_SCROLLBAR_GUTTER_PROPERTY = "--session-scrollbar-gutter"');
    expect(composer).toContain("overflow-x-hidden overflow-y-auto overscroll-contain");
    expect(composer).toContain("px-0 min-[761px]:px-[var(--session-scrollbar-gutter,0px)]");
    expect(markdown).toContain("max-width: 72ch;");
    expect(markdown).not.toContain("margin-inline: auto;");
  });

  test("HITL overlays and Tooltips use their exclusive ownership tokens", async () => {
    const bell = await source("components/features/HitlBell.tsx");
    const iconAction = await source("components/primitives/IconAction.tsx");
    const projectBar = await source("components/features/ProjectBar.tsx");
    expect(bell).toContain("rounded-md border border-border-strong bg-bg-overlay p-3 shadow-lg");
    expect(bell).toContain("rounded-lg border border-border-default bg-bg-overlay p-3 shadow-md");
    expect(bell).toContain("hover:bg-rail-hover");
    expect(bell).not.toContain("hover:bg-rail-ink/8");
    expect(iconAction).toContain('role="tooltip"');
    expect(iconAction).toContain("rounded-lg border border-border-default bg-bg-overlay");
    expect(projectBar.match(/role="tooltip"/g)?.length).toBe(3);
    expect(projectBar.match(/rounded-lg border border-border-default bg-bg-overlay/g)?.length).toBe(2);
  });

  test("Project Todo capture, detail, and Goal editors use the current compact controls", async () => {
    const todos = await source("routes/project-todos.tsx");
    const todoDetail = await source("routes/project-todo-detail.tsx");
    const goal = await source("components/features/SessionGoalSummaryRow.tsx");
    expect(todos).toContain('role="dialog" aria-modal="true" aria-labelledby="new-todo-title"');
    expect(todos).toContain("w-[min(560px,calc(100vw-32px))]");
    expect(todos).toContain('htmlFor="new-todo-content"');
    expect(todos).toContain('id="new-todo-content"');
    expect(todos).toContain(">Save</button>");
    expect(todos).toContain('"Run now"');
    expect(todoDetail).toContain('aria-label="Todo content"');
    expect(todoDetail).toContain("min-h-8 cursor-pointer items-center justify-center gap-1.5");
    expect(goal).toContain("h-8 rounded-sm border px-3 text-[12px]");
  });
});
