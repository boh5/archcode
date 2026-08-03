import { describe, expect, test } from "bun:test";

const webSource = `${import.meta.dir}/../../`;

async function source(path: string): Promise<string> {
  return await Bun.file(`${webSource}${path}`).text();
}

describe("Automation navigation and detail actions", () => {
  test("detail exposes only Automation controls and Session-linked invocation history", async () => {
    const detail = await source("routes/automation-detail.tsx");
    expect(detail).toContain("Run now");
    expect(detail).toContain("Pause");
    expect(detail).toContain("Resume");
    expect(detail).toContain("Invocation History");
    expect(detail).toContain("Open Session");
    expect(detail).toContain('searchParams.get("invocation")');
    expect(detail).toContain("scrollIntoView");
  });

  test("Automation creation uses the direct structured API", async () => {
    const automations = await source("routes/automations.tsx");
    const dialog = await source("components/features/EditAutomationDialog.tsx");
    expect(automations).toContain("<EditAutomationDialog");
    expect(dialog).toContain("useCreateAutomation");
    expect(automations).not.toContain("usePostMessage");
  });

  test("Automation displays creation provenance", async () => {
    const automation = await source("routes/automation-detail.tsx");
    const context = await source("components/features/context-inspector/SessionContextDetails.tsx");
    expect(automation).toContain("Created from");
    expect(automation).toContain("todos/${encodeURIComponent(automation.origin.todoId)}");
    expect(automation).toContain("projectTodoDisplayLabel(linkedTodo.content, linkedTodo.id)");
    expect(context).toContain("Created here");
  });

  test("Automation enablement uses static domain status glyphs", async () => {
    const list = await source("routes/automations.tsx");
    const detail = await source("routes/automation-detail.tsx");
    expect(list).toContain("automationVisualKind(automation.status)");
    expect(detail).toContain("automationVisualKind(automation.status)");
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
  });

  test("list keeps one compact filter and direct creation control", async () => {
    const list = await source("routes/automations.tsx");
    const detail = await source("routes/automation-detail.tsx");
    expect(list).toContain('placeholder="Filter Automations…"');
    expect(list).toContain("New Automation");
    expect(list).toContain("detailSearch={detailSearch}");
    expect(list).toContain('aria-current={selected ? "page" : undefined}');
    expect(list).toContain("restoreRowRef.current?.focus()");
    expect(detail).toContain("to={automationsHref}");
    expect(detail).toContain("state={{ restoreAutomationId: automation.id }}");
    expect(detail).toContain("<AutomationsRoute />");
    expect(list).not.toContain("<main");
    expect(list).not.toContain("<h1");
  });

  test("detail keeps schedule and due metadata readable", async () => {
    const detail = await source("routes/automation-detail.tsx");
    expect(detail.match(/text-\[11px\] leading-4 text-text-tertiary/g)?.length).toBeGreaterThanOrEqual(2);
    expect(detail).toContain('min-[841px]:block');
    expect(detail).not.toContain('min-[980px]:block');
    expect(detail).toContain('label="Stable ID"');
    expect(detail).toContain('label="Updated"');
    expect(detail).toContain('label="Workspace"');
    expect(detail).toContain('latestInvocation?.status === "failed" || latestInvocation?.status === "missed"');
    expect(detail).toContain("?invocation=${encodeURIComponent(item.id)}");
  });
});
