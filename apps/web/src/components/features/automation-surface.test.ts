import { describe, expect, test } from "bun:test";

const webSource = `${import.meta.dir}/../../`;

async function source(path: string): Promise<string> {
  return await Bun.file(`${webSource}${path}`).text();
}

describe("Automation navigation and detail actions", () => {
  test("detail exposes only Automation controls and Session-linked invocation history", async () => {
    const detail = await source("routes/automation-detail.tsx");
    const dialog = await source("components/features/EditAutomationDialog.tsx");
    const presentation = await source("lib/automation-surface-presentation.ts");
    expect(detail).toContain("Run now");
    expect(detail).toContain("<PrimaryActionButton disabled={runNow.isPending}");
    expect(presentation).toContain('"Lead + principal"');
    expect(presentation).toContain('"Target Session’s existing Agent + Profile"');
    expect(dialog).toContain(">Definition controls</span>");
    expect(dialog).toContain('automation.status === "paused" ? "Resume Automation" : "Pause Automation"');
    expect(dialog).toContain("Delete Automation");
    expect(detail).toContain(">Recent runs</span>");
    expect(detail).toContain("Open Session");
    expect(detail).toContain('searchParams.get("invocation")');
    expect(detail).toContain("scrollIntoView");
  });

  test("Automation creation uses the direct structured API", async () => {
    const automations = await source("routes/automations.tsx");
    const dialog = await source("components/features/EditAutomationDialog.tsx");
    expect(automations).toContain("<EditAutomationDialog");
    expect(dialog).toContain("useCreateAutomation");
    expect(dialog).toContain(">Session binding</span>");
    expect(dialog).toContain(">Lead <i");
    expect(automations).not.toContain("usePostMessage");
  });

  test("Automation displays creation provenance", async () => {
    const automation = await source("routes/automation-detail.tsx");
    const context = await source("components/features/context-inspector/SessionContextDetails.tsx");
    expect(automation).toContain("Created from");
    expect(automation).toContain("todos/${encodeURIComponent(automation.origin.todoId)}");
    expect(automation).toContain("projectTodoContentExcerpt(linkedTodoContent)");
    expect(automation).toContain("<ListTodo size={12}");
    expect(context).toContain("Created here");
  });

  test("Automation groups use their current semantic orbit glyphs", async () => {
    const list = await source("routes/automations.tsx");
    const detail = await source("routes/automation-detail.tsx");
    expect(list).toContain("function AutomationStatusOrbit");
    expect(list).toContain('group === "inactive"');
    expect(list).toContain("<Square size={12}");
    expect(list).toContain("<Pause size={12}");
    expect(list).toContain("<Repeat2 size={12}");
    expect(detail).toContain("presentation.statusLabel");
  });

  test("detail header uses the locked control language", async () => {
    const detail = await source("routes/automation-detail.tsx");
    expect(detail).toContain('text-[16px] font-semibold leading-[1.35]');
    expect(detail).toContain('<footer className="flex justify-end gap-[7px]');
    expect(detail).toContain('<Pencil size={13}');
    expect(detail).toContain('<Play size={13}');
    expect(detail).toContain('onClick={() => setEditing(true)}');
    expect(detail).toContain("<PrimaryActionButton disabled={runNow.isPending}");
    expect(detail).not.toContain("<Pause");
    expect(detail).not.toContain("<Trash2");
  });

  test("list keeps one compact filter and direct creation control", async () => {
    const list = await source("routes/automations.tsx");
    const detail = await source("routes/automation-detail.tsx");
    expect(list).toContain('placeholder="Filter Automations…"');
    expect(list).toContain("New Automation");
    expect(list).toContain("detailSearch={detailSearchSuffix}");
    expect(list).toContain('aria-current={selected ? "page" : undefined}');
    expect(list).toContain("restoreRowRef.current?.focus()");
    expect(list).toContain("state={{ focusAutomationDetail: true }}");
    expect(detail).toContain("to={automationsHref}");
    expect(detail).toContain("state={{ restoreAutomationId: value.id }}");
    expect(detail).toContain("titleRef.current?.focus({ preventScroll: true })");
    expect(detail).toContain('window.matchMedia("(max-width: 840px)")');
    expect(detail).toContain("<AutomationsRoute detail={(");
    expect(list).not.toContain("<main");
    expect(list).toContain(">Schedules <span");
  });

  test("inventory uses the four locked decision groups and desktop split breakpoint", async () => {
    const list = await source("routes/automations.tsx");
    const detail = await source("routes/automation-detail.tsx");
    expect(list).toContain('"needs-you"');
    expect(list).toContain('"Needs you"');
    expect(list).toContain('"scheduled"');
    expect(list).toContain('"paused"');
    expect(list).toContain('"inactive"');
    expect(list).toContain("hidden min-[841px]:block");
    expect(list).toContain('aria-label="Selected Automation detail"');
    expect(list).toContain('window.matchMedia("(min-width: 841px)")');
    expect(list).toContain('groups["needs-you"][0] ?? groups.scheduled[0] ?? groups.paused[0] ?? groups.inactive[0]');
    expect(list).toContain('{ replace: true }');
  });

  test("detail keeps schedule and due metadata readable", async () => {
    const detail = await source("routes/automation-detail.tsx");
    expect(detail).toContain('label="Trigger"');
    expect(detail).toContain(">Message</span>");
    expect(detail).toContain('label="Stable ID"');
    expect(detail).toContain('label="Next run"');
    expect(detail).toContain('label="Location"');
    expect(detail).toContain('latestInvocation?.status === "failed" || latestInvocation?.status === "missed"');
    expect(detail).toContain('problemInvocation.status === "failed"');
    expect(detail).toContain("?invocation=${encodeURIComponent(item.id)}");
  });
});
