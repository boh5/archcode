import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Search, X } from "lucide-react";
import type { ProjectAutomationInventoryItem } from "../api/types";
import { useAutomationInventory, useProjectTodos, useSessionInventory } from "../api/queries";
import { EditAutomationDialog } from "../components/features/EditAutomationDialog";
import { PrimaryActionButton } from "../components/primitives/PrimaryActionButton";
import { automationInvocationStatusLabel, automationStatusLabel } from "../lib/automation-status-presentation";
import { formatAutomationTrigger } from "../lib/automation-trigger-presentation";
import { deriveAutomationHitlAttention, indexAutomationSessionLinks } from "../lib/automation-hitl-attention";
import {
  presentAutomationSurface,
  type AutomationSurfaceGroup,
  type AutomationSurfacePresentation,
} from "../lib/automation-surface-presentation";
import { useAttentionVisibleScopedHitl } from "../store/hitl-store";
import { useSessionRuntimeFamilies } from "../store/session-runtime-store";

export type AutomationInventoryGroup = AutomationSurfaceGroup;

export interface PresentedAutomationInventoryItem {
  readonly item: ProjectAutomationInventoryItem;
  readonly presentation: AutomationSurfacePresentation;
}

export function classifyAutomationInventory(
  rows: readonly PresentedAutomationInventoryItem[],
): Record<AutomationInventoryGroup, PresentedAutomationInventoryItem[]> {
  const groups: Record<AutomationInventoryGroup, PresentedAutomationInventoryItem[]> = {
    "needs-you": [], scheduled: [], paused: [], inactive: [],
  };
  for (const row of rows) {
    groups[row.presentation.group].push(row);
  }
  for (const values of Object.values(groups)) {
    values.sort((a, b) => b.item.automation.updatedAt.localeCompare(a.item.automation.updatedAt));
  }
  return groups;
}

export function matchesAutomationInventory(
  item: ProjectAutomationInventoryItem,
  query: string,
  todoContents: ReadonlyMap<string, string>,
  presentation: AutomationSurfacePresentation,
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
    presentation.statusLabel,
    presentation.rowSignal,
    presentation.context,
    automation.origin.kind,
    automation.origin.kind === "todo" ? automation.origin.todoId : undefined,
    linkedTodoContent,
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

export function automationInventoryEmptyMessage(totalCount: number): string {
  return totalCount === 0
    ? "No Automations yet. Create one to schedule or repeat work."
    : "No Automations match this name, ID, action, or schedule.";
}

export function AutomationsRoute({ detail }: { detail?: ReactNode } = {}) {
  const { slug = "", automationId } = useParams<{ slug: string; automationId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const inventory = useAutomationInventory(slug);
  const sessionInventory = useSessionInventory(slug);
  const todos = useProjectTodos(slug);
  const scopedHitl = useAttentionVisibleScopedHitl([slug]);
  const runtimeFamilies = useSessionRuntimeFamilies();
  const todoContents = useMemo(() => new Map((todos.data ?? []).map((todo) => [todo.id, todo.content])), [todos.data]);
  const sessionLinksByAutomation = useMemo(
    () => indexAutomationSessionLinks(sessionInventory.data ?? []),
    [sessionInventory.data],
  );
  const sessionsById = useMemo(
    () => new Map((sessionInventory.data ?? []).map((item) => [item.session.sessionId, item])),
    [sessionInventory.data],
  );
  const activityBySessionId = useMemo(() => new Map(
    Object.values(runtimeFamilies)
      .filter((family) => family.projectSlug === slug)
      .map((family) => [family.rootSessionId, family.activity] as const),
  ), [runtimeFamilies, slug]);
  const presentedRows = useMemo<PresentedAutomationInventoryItem[]>(() => (inventory.data ?? []).map((item) => {
    const sessionLinks = sessionLinksByAutomation.get(item.automation.id) ?? [];
    const attention = deriveAutomationHitlAttention(item.automation, sessionLinks, scopedHitl);
    const targetSession = item.automation.action.kind === "send_message"
      ? sessionsById.get(item.automation.action.sessionId)
      : undefined;
    const linkedTodoContent = item.automation.origin.kind === "todo"
      ? todoContents.get(item.automation.origin.todoId)
      : undefined;
    return {
      item,
      presentation: presentAutomationSurface({
        item,
        attention,
        sessionLinks,
        targetSession,
        activityBySessionId,
        linkedTodoContent,
      }),
    };
  }), [activityBySessionId, inventory.data, scopedHitl, sessionLinksByAutomation, sessionsById, todoContents]);
  const query = searchParams.get("q") ?? "";
  const filtered = useMemo(() => {
    return presentedRows.filter(({ item, presentation }) => matchesAutomationInventory(item, query, todoContents, presentation));
  }, [presentedRows, query, todoContents]);
  const groups = useMemo(() => classifyAutomationInventory(filtered), [filtered]);
  const detailSearch = query ? `?q=${encodeURIComponent(query)}` : "";
  const firstVisibleAutomation = groups["needs-you"][0] ?? groups.scheduled[0] ?? groups.paused[0] ?? groups.inactive[0];
  const restoreAutomationId = typeof location.state === "object" && location.state !== null && "restoreAutomationId" in location.state
    ? String(location.state.restoreAutomationId)
    : undefined;
  const restoreRowRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (!inventory.isLoading && restoreAutomationId !== undefined) restoreRowRef.current?.focus();
  }, [inventory.isLoading, restoreAutomationId]);
  useEffect(() => {
    if (detail !== undefined || automationId !== undefined || inventory.isLoading || firstVisibleAutomation === undefined || typeof window.matchMedia !== "function") return;
    const splitViewport = window.matchMedia("(min-width: 841px)");
    const openFirstVisible = () => {
      if (!splitViewport.matches) return;
      navigate(
        `/projects/${encodeURIComponent(slug)}/automations/${encodeURIComponent(firstVisibleAutomation.item.automation.id)}${detailSearch}`,
        { replace: true },
      );
    };
    openFirstVisible();
    splitViewport.addEventListener("change", openFirstVisible);
    return () => splitViewport.removeEventListener("change", openFirstVisible);
  }, [automationId, detail, detailSearch, firstVisibleAutomation, inventory.isLoading, navigate, slug]);
  const setQuery = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("q", value); else next.delete("q");
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-base" aria-label="Automations workspace">
      <header className="grid min-h-[58px] shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center justify-between gap-3 border-b border-border-default bg-bg-surface px-3 py-[14px] min-[761px]:px-6 min-[761px]:py-3">
        <label className="group flex h-11 w-full max-w-[420px] min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-[color-mix(in_srgb,var(--bg-base)_82%,var(--bg-surface))] py-0 pl-3 pr-1 text-text-tertiary shadow-[inset_0_1px_0_rgb(255_255_255/3%)] transition-[border-color,background-color,box-shadow] duration-[var(--motion-hover)] hover:border-border-default hover:bg-bg-elevated focus-within:border-brand focus-within:bg-bg-elevated focus-within:[box-shadow:var(--focus)] min-[761px]:h-[38px]">
          <Search className="shrink-0 transition-colors duration-[var(--motion-hover)] group-focus-within:text-brand" size={14} aria-hidden="true" />
          <span className="sr-only">Filter Automations</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter Automations…" autoComplete="off" spellCheck={false} className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent px-0.5 text-[16px] text-text-primary outline-none placeholder:text-text-tertiary [&::-webkit-search-cancel-button]:appearance-none min-[761px]:text-[12px]" />
          {query ? <button type="button" aria-label="Clear Automation filter" onClick={() => setQuery("")} className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"><X size={12} aria-hidden="true" /></button> : null}
        </label>
        <PrimaryActionButton className="px-2.5 min-[761px]:px-[13px]" onClick={() => setCreating(true)}>
          New Automation
        </PrimaryActionButton>
      </header>
      <div className="block min-h-0 flex-1 overflow-auto min-[841px]:grid min-[841px]:grid-cols-[minmax(360px,0.9fr)_minmax(360px,1.1fr)] min-[841px]:overflow-hidden min-[1041px]:grid-cols-[minmax(430px,0.88fr)_minmax(420px,1.12fr)]">
        <section className={`min-h-0 min-w-0 overflow-auto bg-bg-base ${detail === undefined ? "col-span-2" : "hidden min-[841px]:block min-[841px]:border-r min-[841px]:border-border-default"}`} aria-label="Automation list">
          <div className="mx-auto w-full max-w-[760px] px-3 pb-9 pt-[18px] min-[761px]:px-6 min-[761px]:pb-12 min-[761px]:pt-[22px]">
          {inventory.isLoading ? <p className="py-10 text-center text-[13px] text-text-tertiary">Loading Automations…</p> : null}
          {inventory.error ? <p className="py-10 text-center text-[13px] text-error">Failed to load Automations</p> : null}
          {!inventory.isLoading && !inventory.error && filtered.length === 0 ? <p className="py-16 text-center text-[13px] text-text-tertiary">{automationInventoryEmptyMessage(inventory.data?.length ?? 0)}</p> : null}
          {(["needs-you", "scheduled", "paused", "inactive"] as const).map((group) => groups[group].length > 0 ? (
            <AutomationGroup
              detailSearch={detailSearch}
              group={group}
              items={groups[group]}
              key={group}
              restoreAutomationId={restoreAutomationId}
              restoreRowRef={restoreRowRef}
              selectedAutomationId={automationId}
              slug={slug}
            />
          ) : null)}
          </div>
        </section>
        {detail !== undefined ? <section className="min-h-0 min-w-0 overflow-visible bg-bg-surface min-[841px]:overflow-auto" aria-label="Selected Automation detail">{detail}</section> : null}
      </div>
      <EditAutomationDialog open={creating} onClose={() => setCreating(false)} slug={slug} />
    </div>
  );
}

function AutomationGroup({ detailSearch, group, items, restoreAutomationId, restoreRowRef, selectedAutomationId, slug }: {
  detailSearch: string;
  group: AutomationInventoryGroup;
  items: readonly PresentedAutomationInventoryItem[];
  restoreAutomationId?: string;
  restoreRowRef: RefObject<HTMLAnchorElement | null>;
  selectedAutomationId?: string;
  slug: string;
}) {
  const label = group === "needs-you" ? "Needs you" : group === "scheduled" ? "Scheduled" : group === "paused" ? "Paused" : "Inactive";
  return (
    <section className="[&+section]:mt-6" aria-labelledby={`automations-${group}`}>
      <header className="flex items-baseline justify-between gap-3 px-0.5 pb-2">
        <h2 id={`automations-${group}`} className="text-[11px] font-bold uppercase tracking-[0.06em] text-text-primary">{label}</h2>
        <span className="text-[10px] text-text-tertiary">{items.length}</span>
      </header>
      <div className="border-t border-border-default">
        {items.map(({ item: { automation }, presentation }) => {
          const selected = automation.id === selectedAutomationId;
          const signalTone = presentation.tone === "error"
            ? "text-error"
            : presentation.tone === "attention"
              ? "text-warning"
              : presentation.tone === "running"
                ? "text-signal-foreground"
                : "text-text-tertiary";
          return (
            <Link
              aria-current={selected ? "page" : undefined}
              key={automation.id}
              ref={automation.id === restoreAutomationId ? restoreRowRef : undefined}
              state={{ focusAutomationDetail: true }}
              to={`/projects/${slug}/automations/${automation.id}${detailSearch}`}
              className={`workbench-row-lift grid min-h-[74px] grid-cols-[13px_minmax(0,1fr)_auto] items-start gap-2.5 border-b border-l-2 border-b-border-subtle px-1.5 py-2.5 text-left text-text-secondary transition-[background-color,color,transform,border-color] duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand min-[761px]:min-h-14 min-[761px]:px-3 ${selected ? "border-l-brand bg-selection-field" : "border-l-transparent"}`}
            >
              <AutomationStatusOrbit orbit={presentation.orbit} />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-text-primary">{automation.name}</span>
                <span className="mt-[5px] block truncate text-[11px] leading-[1.45] text-text-tertiary">{presentation.context}</span>
              </span>
              <span className={`shrink-0 whitespace-nowrap text-[10.5px] font-semibold ${signalTone}`}>{presentation.rowSignal}</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function AutomationStatusOrbit({ orbit }: { orbit: AutomationSurfacePresentation["orbit"] }) {
  const tone = orbit === "failed"
    ? "border-error bg-error shadow-[inset_0_0_0_2px_var(--bg-base)]"
    : orbit === "attention"
      ? "border-warning bg-warning shadow-[inset_0_0_0_2px_var(--bg-base)]"
      : orbit === "running"
        ? "animate-activity border-signal border-t-transparent bg-transparent"
        : "border-text-tertiary bg-transparent";
  return <span aria-hidden="true" className={`mt-[3px] box-border h-[10px] w-[10px] shrink-0 rounded-full border-[1.5px] ${tone}`} />;
}
