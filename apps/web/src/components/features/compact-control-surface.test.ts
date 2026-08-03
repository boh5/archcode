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

  test("Model Picker keeps the shared Popover surface with two quiet ghost triggers", async () => {
    const picker = await source("components/features/ModelPicker.tsx");
    expect(picker).toContain("rounded-lg border border-border-default bg-bg-overlay");
    expect(picker).toContain('className="relative flex min-w-0 items-center gap-0.5"');
    expect(picker).toContain("transition-[background-color,color]");
    expect(picker).not.toContain("rounded-sm border border-border-subtle bg-bg-base p-0.5");
  });

  test("Composer owns overlay Menu styling and keeps Send/Stop on the control grammar", async () => {
    const chat = await source("components/features/ChatInput.tsx");
    expect(chat).toContain("rounded-lg border border-border-default bg-bg-overlay p-1 shadow-md");
    expect(chat).toContain("text-[12px] leading-4 text-text-tertiary");
    expect(chat).toContain("h-8 w-8 items-center justify-center rounded-sm transition-colors");
  });

  test("task-critical header metadata uses the tertiary foreground", async () => {
    const header = await source("components/features/ChatHeader.tsx");

    expect(header).toContain("text-[12px] text-text-tertiary");
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
    expect(workstream).toContain("work-summary-control group relative flex min-h-8");
    expect(workstream).toContain('data-testid={`work-divider-${segment.id}`}');
    expect(workstream).not.toContain("work-summary-control relative flex min-h-8");
    expect(delegation).toContain("rounded-md border border-border-subtle bg-bg-elevated");
    expect(delegation).toContain("border-b border-border-subtle bg-transparent");
  });

  test("the transcript and Composer share one visible thread column", async () => {
    const workstream = await source("components/composite/ExecutionWorkstream.tsx");
    const composer = await source("components/features/SessionComposerDock.tsx");
    const rail = await source("components/primitives/ConversationRail.tsx");
    const markdown = await source("components/primitives/MarkdownContent.css");

    expect(rail).toContain("export function SessionThreadColumn");
    expect(rail).toContain("mx-auto w-full max-w-[800px] min-w-0");
    expect(rail).toContain('WORK_ACTIVITY_LANE_CLASS = "w-full max-w-[720px] min-w-0"');
    expect(rail).toContain('WORK_ACTIVITY_CHILD_LANE_CLASS = "w-full max-w-[696px] min-w-0"');
    expect(rail).toContain('WORK_ACTIVITY_NESTED_LANE_CLASS = "w-full max-w-[676px] min-w-0"');
    expect(workstream).toContain('data-testid="execution-thread-column"');
    expect(composer).toContain('data-testid="composer-thread-column"');
    expect(workstream).not.toContain("CONVERSATION_TURN_LANE_CLASS");
    expect(workstream).toContain("absolute -left-4 top-1/2");
    expect(workstream).toContain('scrollbarGutter: "stable both-edges"');
    expect(workstream).toContain('const SESSION_SCROLLBAR_GUTTER_PROPERTY = "--session-scrollbar-gutter"');
    expect(composer).not.toContain("overflow-x-hidden");
    expect(composer).not.toContain("scrollbarGutter");
    expect(composer).toContain('paddingInline: "var(--session-scrollbar-gutter, 0px)"');
    expect(markdown).toContain("max-width: 72ch;");
    expect(markdown).not.toContain("margin-inline: auto;");
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

  test("the tablet Inspector overlay starts below project and Session headers", async () => {
    const rootLayout = await source("routes/root-layout.tsx");
    expect(rootLayout).toContain("max-[1180px]:top-28");
    expect(rootLayout).not.toContain("max-[1180px]:top-12");
  });

  test("Project Todo and Goal editors use control radius and 32px actions", async () => {
    const todos = await source("routes/project-todos.tsx");
    const todoDetail = await source("routes/project-todo-detail.tsx");
    const goal = await source("components/features/SessionGoalSummaryRow.tsx");
    expect(todos).toContain('aria-label="New Todo content"');
    expect(todos).toContain("max-[620px]:basis-[calc(100%-24px)]");
    expect(todos).toContain("max-[620px]:basis-full max-[620px]:grid max-[620px]:grid-cols-2");
    expect(todos.match(/max-\[620px\]:h-11/g)).toHaveLength(2);
    expect(todoDetail).toContain('aria-label="Todo content"');
    expect(todoDetail).toContain("min-h-8 items-center gap-1.5 rounded-sm border");
    expect(goal).toContain("h-8 rounded-sm border px-3 text-[12px]");
  });
});
