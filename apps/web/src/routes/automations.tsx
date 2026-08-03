import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { Plus, Search } from "lucide-react";
import { projectTodoDisplayLabel } from "@archcode/protocol";
import type { ProjectAutomationInventoryItem } from "../api/types";
import { useAutomationInventory, useProjectTodos } from "../api/queries";
import { EditAutomationDialog } from "../components/features/EditAutomationDialog";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { RelativeTime } from "../components/primitives/TemporalText";
import { automationInvocationStatusLabel, automationStatusLabel, automationVisualKind } from "../lib/automation-status-presentation";
import { formatAutomationTrigger } from "../lib/automation-trigger-presentation";

export type AutomationInventoryGroup = "needs-attention" | "scheduled" | "paused" | "inactive";

export function classifyAutomationInventory(
  items: readonly ProjectAutomationInventoryItem[],
): Record<AutomationInventoryGroup, ProjectAutomationInventoryItem[]> {
  const groups: Record<AutomationInventoryGroup, ProjectAutomationInventoryItem[]> = {
    "needs-attention": [], scheduled: [], paused: [], inactive: [],
  };
  for (const item of items) {
    if (item.latestInvocation?.status === "failed" || item.latestInvocation?.status === "missed") groups["needs-attention"].push(item);
    else if (item.automation.status === "active") groups.scheduled.push(item);
    else if (item.automation.status === "paused") groups.paused.push(item);
    else groups.inactive.push(item);
  }
  for (const values of Object.values(groups)) values.sort((a, b) => b.automation.updatedAt.localeCompare(a.automation.updatedAt));
  return groups;
}

export function matchesAutomationInventory(
  item: ProjectAutomationInventoryItem,
  query: string,
  todoContents: ReadonlyMap<string, string>,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return true;
  const { automation, latestInvocation } = item;
  const linkedTodoContent = automation.origin.kind === "todo" ? todoContents.get(automation.origin.todoId) : undefined;
  return [
    automation.name,
    automation.id,
    automation.action.message,
    automation.action.kind,
    automation.action.kind === "send_message" ? automation.action.sessionId : automation.action.location,
    automation.trigger.kind,
    formatAutomationTrigger(automation.trigger),
    automationStatusLabel(automation.status),
    latestInvocation ? automationInvocationStatusLabel(latestInvocation.status) : "No runs",
    automation.origin.kind,
    automation.origin.kind === "todo" ? automation.origin.todoId : undefined,
    linkedTodoContent,
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

export function AutomationsRoute() {
  const { slug = "", automationId } = useParams<{ slug: string; automationId?: string }>();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const inventory = useAutomationInventory(slug);
  const todos = useProjectTodos(slug);
  const todoContents = useMemo(() => new Map((todos.data ?? []).map((todo) => [todo.id, todo.content])), [todos.data]);
  const query = searchParams.get("q") ?? "";
  const filtered = useMemo(() => {
    return (inventory.data ?? []).filter((item) => matchesAutomationInventory(item, query, todoContents));
  }, [inventory.data, query, todoContents]);
  const groups = useMemo(() => classifyAutomationInventory(filtered), [filtered]);
  const detailSearch = query ? `?q=${encodeURIComponent(query)}` : "";
  const restoreAutomationId = typeof location.state === "object" && location.state !== null && "restoreAutomationId" in location.state
    ? String(location.state.restoreAutomationId)
    : undefined;
  const restoreRowRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (!inventory.isLoading && restoreAutomationId !== undefined) restoreRowRef.current?.focus();
  }, [inventory.isLoading, restoreAutomationId]);
  const setQuery = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("q", value); else next.delete("q");
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="h-full overflow-y-auto bg-bg-base" aria-label="Automations workspace">
      <div className="mx-auto w-full max-w-[1080px] px-4 pb-12 pt-4 min-[761px]:px-6">
        <div className="flex items-center gap-2">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Filter Automations</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={14} aria-hidden="true" />
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter Automations…" className="h-9 w-full rounded-sm border border-control-border bg-bg-elevated pl-9 pr-3 text-[13px] outline-none focus:border-brand focus:ring-2 focus:ring-brand-subtle [@media(pointer:coarse)]:h-11" />
          </label>
          <button type="button" onClick={() => setCreating(true)} className="inline-flex h-9 shrink-0 items-center gap-2 rounded-sm bg-brand px-3 text-[12px] font-semibold text-brand-ink hover:bg-brand-hover [@media(pointer:coarse)]:h-11">
            <Plus size={14} aria-hidden="true" /> New Automation
          </button>
        </div>
        {inventory.isLoading ? <p className="py-10 text-center text-[13px] text-text-tertiary">Loading Automations…</p> : null}
        {inventory.error ? <p className="py-10 text-center text-[13px] text-error">Failed to load Automations</p> : null}
        {!inventory.isLoading && !inventory.error && filtered.length === 0 ? <p className="py-16 text-center text-[13px] text-text-tertiary">No Automations match this name, ID, action, or schedule.</p> : null}
        {(["needs-attention", "scheduled", "paused", "inactive"] as const).map((group) => groups[group].length > 0 ? (
          <AutomationGroup
            detailSearch={detailSearch}
            group={group}
            items={groups[group]}
            key={group}
            restoreAutomationId={restoreAutomationId}
            restoreRowRef={restoreRowRef}
            selectedAutomationId={automationId}
            slug={slug}
            todoContents={todoContents}
          />
        ) : null)}
      </div>
      <EditAutomationDialog open={creating} onClose={() => setCreating(false)} slug={slug} />
    </div>
  );
}

function AutomationGroup({ detailSearch, group, items, restoreAutomationId, restoreRowRef, selectedAutomationId, slug, todoContents }: {
  detailSearch: string;
  group: AutomationInventoryGroup;
  items: readonly ProjectAutomationInventoryItem[];
  restoreAutomationId?: string;
  restoreRowRef: RefObject<HTMLAnchorElement | null>;
  selectedAutomationId?: string;
  slug: string;
  todoContents: ReadonlyMap<string, string>;
}) {
  const label = group === "needs-attention" ? "Needs attention" : group === "scheduled" ? "Scheduled" : group === "paused" ? "Paused" : "Inactive";
  return (
    <section className="mt-7" aria-labelledby={`automations-${group}`}>
      <h2 id={`automations-${group}`} className="pb-2 text-[12px] font-semibold text-text-secondary">{label}</h2>
      <div className="divide-y divide-border-subtle border-y border-border-subtle">
        {items.map(({ automation, latestInvocation }) => {
          const needsAttention = group === "needs-attention";
          const selected = automation.id === selectedAutomationId;
          const latestStatus = latestInvocation ? automationInvocationStatusLabel(latestInvocation.status) : "No runs";
          const definitionStatus = automationStatusLabel(automation.status);
          const linkedTodoContent = automation.origin.kind === "todo" ? todoContents.get(automation.origin.todoId) : undefined;
          const linkedTodo = automation.origin.kind === "todo"
            ? linkedTodoContent === undefined
              ? automation.origin.todoId
              : projectTodoDisplayLabel(linkedTodoContent, automation.origin.todoId)
            : undefined;
          return (
            <Link
              aria-current={selected ? "page" : undefined}
              key={automation.id}
              ref={automation.id === restoreAutomationId ? restoreRowRef : undefined}
              to={`/projects/${slug}/automations/${automation.id}${detailSearch}`}
              className={`flex min-h-14 items-center gap-3 px-3 py-2.5 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${selected ? "bg-brand-subtle" : ""}`}
            >
              <StatusGlyph kind={needsAttention ? "failed" : automationVisualKind(automation.status)} size={14} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-text-primary">{automation.name}</span>
                <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">{formatAutomationTrigger(automation.trigger)} · {automation.action.kind === "start_session" ? "Start Session" : "Send message"}{linkedTodo ? ` · ${linkedTodo}` : ""} · {automation.id}</span>
              </span>
              <span className={`shrink-0 text-[11px] ${needsAttention ? "font-semibold text-error" : "text-text-tertiary"}`}>{definitionStatus} · {latestStatus}</span>
              <span className="hidden shrink-0 text-[11px] text-text-tertiary min-[680px]:inline"><RelativeTime timestamp={Date.parse(automation.updatedAt)} /></span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
