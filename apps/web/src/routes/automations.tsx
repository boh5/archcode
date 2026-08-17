import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronRight, Pause, Plus, Repeat2, Search, Square, X } from "lucide-react";
import type { ProjectAutomationInventoryItem } from "../api/types";
import { useAutomationInventory, useProjectTodos, useSessionInventory } from "../api/queries";
import { EditAutomationDialog } from "../components/features/EditAutomationDialog";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
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
type AutomationStatusFilter = "all" | "active" | "paused";

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
  const statusParam = searchParams.get("status");
  const statusFilter: AutomationStatusFilter = statusParam === "active" || statusParam === "paused" ? statusParam : "all";
  const filtered = useMemo(() => {
    return presentedRows.filter(({ item, presentation }) => {
      if (statusFilter === "active" && item.automation.status !== "active") return false;
      if (statusFilter === "paused" && item.automation.status !== "paused") return false;
      return matchesAutomationInventory(item, query, todoContents, presentation);
    });
  }, [presentedRows, query, statusFilter, todoContents]);
  const groups = useMemo(() => classifyAutomationInventory(filtered), [filtered]);
  const detailSearch = new URLSearchParams({
    ...(query ? { q: query } : {}),
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
  }).toString();
  const detailSearchSuffix = detailSearch ? `?${detailSearch}` : "";
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
        `/projects/${encodeURIComponent(slug)}/automations/${encodeURIComponent(firstVisibleAutomation.item.automation.id)}${detailSearchSuffix}`,
        { replace: true },
      );
    };
    openFirstVisible();
    splitViewport.addEventListener("change", openFirstVisible);
    return () => splitViewport.removeEventListener("change", openFirstVisible);
  }, [automationId, detail, detailSearchSuffix, firstVisibleAutomation, inventory.isLoading, navigate, slug]);
  const setQuery = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("q", value); else next.delete("q");
    setSearchParams(next, { replace: true });
  };
  const setStatus = (value: AutomationStatusFilter) => {
    const next = new URLSearchParams(searchParams);
    if (value === "all") next.delete("status"); else next.set("status", value);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-base" aria-label="Schedules workspace">
      <header className="flex min-h-[58px] shrink-0 items-center gap-2 border-b border-border-default bg-bg-surface py-2.5 pl-[66px] pr-3 min-[981px]:px-[18px]">
        <div className="min-w-0">
          <p className="text-[9px] font-semibold uppercase leading-3 tracking-[0.08em] text-text-tertiary">Operations</p>
          <h1 className="mt-px text-[17px] font-semibold leading-5 tracking-[-0.025em] text-text-primary">Schedules <span className="ml-1 inline-flex min-h-[19px] items-center rounded-full bg-bg-muted px-2 align-middle text-[10px] font-semibold tabular-nums text-text-secondary">{inventory.data?.length ?? 0}</span></h1>
        </div>
      </header>
      <div className="grid shrink-0 grid-cols-1 gap-2 border-b border-border-default bg-bg-base px-3 pb-[14px] pt-[18px] min-[721px]:flex min-[721px]:items-center min-[721px]:justify-between min-[721px]:px-5 min-[721px]:pt-7 min-[761px]:gap-[14px]">
        <label className="group flex h-11 w-full max-w-none min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-[color-mix(in_srgb,var(--bg-base)_82%,var(--bg-surface))] py-0 pl-3 pr-1 text-text-tertiary shadow-[inset_0_1px_0_rgb(255_255_255/3%)] transition-[border-color,background-color,box-shadow] duration-[var(--motion-fast)] hover:border-border-default hover:bg-bg-elevated focus-within:border-brand focus-within:bg-bg-elevated focus-within:[box-shadow:var(--focus)] min-[721px]:max-w-[430px] min-[721px]:flex-[0_1_430px] min-[761px]:h-[38px]">
          <Search className="shrink-0 transition-colors duration-[var(--motion-fast)] group-focus-within:text-brand" size={14} aria-hidden="true" />
          <span className="sr-only">Filter Automations</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter Automations…" autoComplete="off" spellCheck={false} className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent px-0.5 text-[16px] text-text-primary outline-none placeholder:text-text-tertiary [&::-webkit-search-cancel-button]:appearance-none min-[721px]:text-[12px]" />
          {query ? <button type="button" aria-label="Clear Automation filter" onClick={() => setQuery("")} className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"><X size={12} aria-hidden="true" /></button> : null}
        </label>
        <div className="grid grid-cols-1 gap-2 min-[721px]:w-[164px] min-[761px]:flex min-[761px]:w-auto min-[761px]:items-center">
          <div className="flex h-[52px] items-center gap-0.5 rounded-md border border-border-subtle bg-bg-surface p-[3px] min-[761px]:h-[38px]" role="group" aria-label="Automation status">
            {(["all", "active", "paused"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={statusFilter === value}
                onClick={() => setStatus(value)}
                className={`inline-flex min-h-11 items-center justify-center rounded-sm px-2.5 text-[11.5px] font-semibold leading-[1.5] tracking-normal text-text-secondary transition-colors duration-[var(--motion-fast)] focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] min-[761px]:min-h-[30px] ${statusFilter === value ? "bg-bg-active text-text-primary shadow-sm" : "hover:bg-bg-hover hover:text-text-primary"}`}
              >
                {value[0].toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="inline-flex h-11 min-h-11 items-center justify-center gap-[7px] whitespace-nowrap rounded-md border border-border-default bg-bg-surface px-2.5 text-[11.5px] font-semibold leading-[1.5] tracking-normal text-text-tertiary transition-[background-color,border-color,color] duration-[var(--motion-fast)] hover:border-border-strong hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] min-[761px]:h-[34px] min-[761px]:min-h-[34px] min-[761px]:px-[11px]"
            onClick={() => setCreating(true)}
          >
            <Plus size={14} aria-hidden="true" /> New Automation
          </button>
        </div>
      </div>
      <div className="block min-h-0 flex-1 overflow-auto min-[841px]:mx-auto min-[841px]:mt-[22px] min-[841px]:grid min-[841px]:w-[calc(100%_-_40px)] min-[841px]:max-w-[1420px] min-[841px]:grid-cols-[minmax(0,1fr)_360px] min-[841px]:grid-rows-[max-content_64px] min-[841px]:items-start min-[841px]:gap-x-[22px] min-[841px]:gap-y-0">
        <section className={`min-h-0 min-w-0 overflow-auto bg-bg-base min-[841px]:overflow-visible ${detail === undefined ? "col-span-2" : "hidden min-[841px]:block"}`} aria-label="Automation list">
          <div className="w-full px-3 pb-9 pt-[18px] min-[721px]:px-5 min-[721px]:pb-12 min-[721px]:pt-[22px] min-[841px]:px-0 min-[841px]:pt-0">
          {inventory.isLoading ? <p className="py-10 text-center text-[13px] text-text-tertiary">Loading Automations…</p> : null}
          {inventory.error ? <p className="py-10 text-center text-[13px] text-error">Failed to load Automations</p> : null}
          {!inventory.isLoading && !inventory.error && filtered.length === 0 ? <p className="py-16 text-center text-[13px] text-text-tertiary">{automationInventoryEmptyMessage(inventory.data?.length ?? 0)}</p> : null}
          {(["needs-you", "scheduled", "paused", "inactive"] as const).map((group) => groups[group].length > 0 ? (
            <AutomationGroup
              detailSearch={detailSearchSuffix}
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
        {detail !== undefined ? <section className="min-h-0 min-w-0 overflow-visible bg-bg-surface min-[841px]:overflow-hidden min-[841px]:rounded-[10px] min-[841px]:border min-[841px]:border-border-default" aria-label="Selected Automation detail">{detail}</section> : null}
        <div aria-hidden="true" className="hidden min-[841px]:col-span-2 min-[841px]:block min-[841px]:h-16" />
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
    <section className="[&+section]:mt-[26px]" aria-labelledby={`automations-${group}`}>
      <header className="flex min-h-[29px] items-baseline justify-between gap-3 px-[7px] pb-2">
        <h2 id={`automations-${group}`} className="text-[11px] font-bold uppercase tracking-[0.06em] text-text-primary">{label}</h2>
        <span className="text-[10.5px] tabular-nums text-text-tertiary">{items.length}</span>
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
              className={`workbench-row-lift grid min-h-[72px] grid-cols-[27px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border-subtle px-2 py-2.5 text-left text-text-secondary transition-[background-color,color,transform,box-shadow] duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand min-[721px]:min-h-[66px] min-[721px]:grid-cols-[30px_minmax(0,1fr)_auto_14px] ${selected ? "my-[5px] !px-2.5 rounded-lg border border-brand/25 bg-selection-field shadow-[inset_2px_0_0_var(--brand)]" : ""}`}
            >
              <AutomationStatusOrbit group={presentation.group} orbit={presentation.orbit} />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold leading-[1.35] text-text-primary">{automation.name}</span>
                <span className="mt-[3px] block truncate text-[10.5px] leading-[1.35] text-text-tertiary">{presentation.context}</span>
              </span>
              <span className={`inline-flex min-h-[23px] shrink-0 items-center whitespace-nowrap rounded-[5px] border px-2 text-[9.5px] font-semibold ${automationStatusLabelClass(presentation.tone)} ${signalTone}`}>{presentation.rowSignal}</span>
              <ChevronRight size={13} className="hidden text-text-tertiary min-[721px]:block" aria-hidden="true" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function AutomationStatusOrbit({ group, orbit }: {
  group: AutomationSurfaceGroup;
  orbit: AutomationSurfacePresentation["orbit"];
}) {
  const frame = orbit === "failed"
    ? "border-[color:color-mix(in_srgb,var(--error)_28%,var(--border-subtle))] bg-error-field"
    : orbit === "attention"
      ? "border-[color:color-mix(in_srgb,var(--warning)_30%,var(--border-subtle))] bg-[linear-gradient(160deg,var(--warning-field),color-mix(in_srgb,var(--warning-field)_78%,var(--bg-muted)))]"
      : orbit === "running"
        ? "border-[color:color-mix(in_srgb,var(--signal)_28%,var(--border-subtle))] bg-[linear-gradient(160deg,var(--signal-field),color-mix(in_srgb,var(--signal-field)_78%,var(--bg-muted)))]"
        : "border-border-subtle bg-[linear-gradient(160deg,color-mix(in_srgb,var(--bg-elevated)_62%,var(--bg-muted)),var(--bg-muted))] text-text-tertiary";
  const content = orbit === "failed"
    ? <StatusGlyph kind="failed" size={12} />
    : orbit === "attention"
      ? <StatusGlyph kind="needs_you" size={12} />
      : orbit === "running"
        ? <StatusGlyph kind="running" size={12} />
        : group === "inactive"
          ? <Square size={12} aria-hidden="true" />
          : orbit === "paused"
            ? <Pause size={12} aria-hidden="true" />
            : <Repeat2 size={12} aria-hidden="true" />;
  return <span aria-hidden="true" className={`grid h-[27px] w-[27px] shrink-0 place-items-center rounded-[7px] border shadow-[inset_0_1px_0_rgb(255_255_255/3%)] ${frame}`}>{content}</span>;
}

function automationStatusLabelClass(tone: AutomationSurfacePresentation["tone"]): string {
  if (tone === "error") return "border-[color:color-mix(in_srgb,var(--error)_24%,transparent)] bg-error-field";
  if (tone === "attention") return "border-[color:color-mix(in_srgb,var(--warning)_24%,transparent)] bg-warning-field";
  if (tone === "running") return "border-[color:color-mix(in_srgb,var(--signal)_24%,transparent)] bg-signal-field";
  return "border-transparent bg-bg-elevated";
}
