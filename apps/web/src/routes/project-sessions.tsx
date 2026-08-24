import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, ChevronDown, ChevronRight, Filter, Plus, Search, X } from "lucide-react";
import { projectTodoContentExcerpt, rootSessionSourceTodoId, type SessionFamilyActivity } from "@archcode/protocol";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useCreateSession } from "../api/mutations";
import { useAutomationInventory, useProjectTodos, useSessionInventory } from "../api/queries";
import type { ProjectSessionInventoryItem } from "../api/types";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { RelativeTime, useElapsedTime } from "../components/primitives/TemporalText";
import { runtimeFamilyKey, useSessionRuntimeFamilies, useSessionRuntimeInitialized } from "../store/session-runtime-store";
import { hitlAttentionLabelsByRootSession, useAttentionVisibleScopedHitl, useHitlProjectInitialized } from "../store/hitl-store";
import type { VisualStatusKind } from "../lib/status-visuals";
import { sessionInventoryIsActive, sessionInventoryNeedsAttention } from "../lib/session-family-presentation";

export type SessionInventoryGroup = "needs-you" | "running" | "recent";
export type SessionSourceFilter = "all" | "todo" | "automation" | "direct";

export function classifySessionInventory(
  items: readonly ProjectSessionInventoryItem[],
  activityBySessionId: ReadonlyMap<string, SessionFamilyActivity>,
  attentionSessionIds: ReadonlySet<string>,
): Record<SessionInventoryGroup, ProjectSessionInventoryItem[]> {
  const groups: Record<SessionInventoryGroup, ProjectSessionInventoryItem[]> = { "needs-you": [], running: [], recent: [] };
  for (const item of items) {
    const id = item.session.sessionId;
    // A runtime family can be waiting on a child dependency without exposing
    // an authoritative HITL request. Only the scoped HITL projection (or an
    // explicit terminal failure) moves a row into Needs you.
    const activity = activityBySessionId.get(id) ?? "idle";
    const hasAttention = attentionSessionIds.has(id);
    if (sessionInventoryNeedsAttention(item, hasAttention)) groups["needs-you"].push(item);
    else if (sessionInventoryIsActive(item, activity, hasAttention)) groups.running.push(item);
    else groups.recent.push(item);
  }
  groups["needs-you"].sort((a, b) => b.session.updatedAt - a.session.updatedAt);
  groups.running.sort((a, b) => b.session.updatedAt - a.session.updatedAt);
  groups.recent.sort((a, b) => b.session.updatedAt - a.session.updatedAt);
  return groups;
}

export function presentSessionInventoryStatus(
  item: ProjectSessionInventoryItem,
  activity: SessionFamilyActivity,
  attentionLabel?: "Inspection" | "Permission" | "Question",
): { label: string; kind: VisualStatusKind; detail?: string } {
  if (attentionLabel !== undefined) return { label: "Needs you", kind: "needs_you", detail: attentionLabel };
  const execution = item.latestExecution;
  if (activity === "waiting_for_human") return { label: "Waiting", kind: "pending", detail: "Waiting for dependency" };
  if (activity !== "idle") return { label: activityLabel(activity), kind: "running" };
  if (execution?.status === "failed") return { label: "Failed", kind: "failed" };
  if (execution?.status === "timed_out") return { label: "Failed", kind: "failed", detail: "Timed out" };
  if (execution === null) return { label: "Idle", kind: "idle" };
  if (execution.status === "running") return { label: "Running", kind: "running" };
  if (execution.status === "suspended") return { label: "Suspended", kind: "blocked" };
  if (execution.status === "completed") return { label: "Completed", kind: "completed" };
  if (execution.status === "max_steps") return { label: "Failed", kind: "failed", detail: "Max steps" };
  const detail = execution.status === "aborted" ? "Aborted"
    : execution.status === "cancelled" ? "Cancelled"
      : "Interrupted";
  return { label: `Stopped · ${detail}`, kind: "stopped" };
}

export function matchesSessionInventory(
  item: ProjectSessionInventoryItem,
  query: string,
  source: SessionSourceFilter,
  todoContents: ReadonlyMap<string, string>,
  automationNames: ReadonlyMap<string, string>,
): boolean {
  const sessionSource = item.session.source;
  if (source !== "all" && sessionSource.kind !== source) return false;

  const sourceParent = sessionSource.kind === "todo"
    ? todoContents.get(sessionSource.todoId) ?? sessionSource.todoId
    : sessionSource.kind === "automation"
      ? automationNames.get(sessionSource.automationId) ?? sessionSource.automationId
      : item.session.agentName;
  const sourceId = sessionSource.kind === "todo"
    ? sessionSource.todoId
    : sessionSource.kind === "automation"
      ? sessionSource.automationId
      : "direct";
  const linkedTodoId = rootSessionSourceTodoId(sessionSource);
  const linkedTodoContent = linkedTodoId === undefined ? undefined : todoContents.get(linkedTodoId);
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return true;
  return [
    item.session.title,
    item.session.sessionId,
    sessionSource.kind,
    sourceId,
    sourceParent,
    linkedTodoContent,
    item.session.agentName,
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

export function sessionInventoryEmptyMessage(totalCount: number): string {
  return totalCount === 0
    ? "No Sessions yet. Start one directly or run work from a Todo."
    : "No Sessions match this title, ID, or source.";
}

export function presentSessionInventoryEmptyState(
  totalCount: number,
  query: string,
  source: SessionSourceFilter,
): { title: string; detail: string; recoveryLabel?: string } {
  if (totalCount === 0) {
    return {
      title: "No Sessions yet",
      detail: "Use New Session above for direct work, or start work from a Todo or Automation.",
    };
  }
  const normalizedQuery = query.trim();
  if (normalizedQuery && source !== "all") {
    return {
      title: "No Sessions match these filters",
      detail: "Try another title or stable ID, or restore All sources.",
      recoveryLabel: "Reset filters",
    };
  }
  if (normalizedQuery) {
    return {
      title: `No Sessions match “${normalizedQuery}”`,
      detail: "Try another Session title or stable ID.",
      recoveryLabel: "Clear filter",
    };
  }
  return {
    title: "No Sessions match this source",
    detail: "Choose All sources to restore the complete Session inventory.",
    recoveryLabel: "Show all",
  };
}

export function ProjectSessionsRoute() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const inventory = useSessionInventory(slug);
  const { data: todos = [] } = useProjectTodos(slug);
  const automationInventory = useAutomationInventory(slug);
  const runtimeFamilies = useSessionRuntimeFamilies();
  const runtimeInitialized = useSessionRuntimeInitialized(slug);
  const attention = useAttentionVisibleScopedHitl([slug]);
  const hitlInitialized = useHitlProjectInitialized(slug);
  const createSession = useCreateSession();
  const filterInputRef = useRef<HTMLInputElement>(null);
  const clearFilterRef = useRef<HTMLButtonElement>(null);
  const newSessionRef = useRef<HTMLButtonElement>(null);
  const query = searchParams.get("q") ?? "";
  const requestedSource = searchParams.get("source");
  const source: SessionSourceFilter = requestedSource === "todo" || requestedSource === "automation" || requestedSource === "direct"
    ? requestedSource
    : "all";

  const todoContents = useMemo(() => new Map(todos.map((todo) => [todo.id, todo.content])), [todos]);
  const todoNames = useMemo(() => new Map(todos.map((todo) => [todo.id, projectTodoContentExcerpt(todo.content)])), [todos]);
  const automationNames = useMemo(() => new Map((automationInventory.data ?? []).map((item) => [item.automation.id, item.automation.name])), [automationInventory.data]);
  const filtered = useMemo(() => {
    return (inventory.data ?? []).filter((item) => matchesSessionInventory(item, query, source, todoContents, automationNames));
  }, [automationNames, inventory.data, query, source, todoContents]);
  const activityBySessionId = useMemo(() => new Map((inventory.data ?? []).map((item) => [
    item.session.sessionId,
    runtimeFamilies[runtimeFamilyKey(slug, item.session.sessionId)]?.activity ?? "idle",
  ])), [inventory.data, runtimeFamilies, slug]);
  const attentionLabelsBySessionId = useMemo(() => hitlAttentionLabelsByRootSession(attention), [attention]);
  const attentionSessionIds = useMemo(() => new Set(attentionLabelsBySessionId.keys()), [attentionLabelsBySessionId]);
  const stateReady = inventory.isSuccess && runtimeInitialized && hitlInitialized;
  const groups = useMemo(() => stateReady
    ? classifySessionInventory(filtered, activityBySessionId, attentionSessionIds)
    : { "needs-you": [], running: [], recent: [] }, [activityBySessionId, attentionSessionIds, filtered, stateReady]);
  const canonicalGroups = useMemo(
    () => stateReady
      ? classifySessionInventory(inventory.data ?? [], activityBySessionId, attentionSessionIds)
      : { "needs-you": [], running: [], recent: [] },
    [activityBySessionId, attentionSessionIds, inventory.data, stateReady],
  );
  const activeCount = stateReady
    ? canonicalGroups["needs-you"].length + canonicalGroups.running.length
    : undefined;
  const setParam = (key: "q" | "source", value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };
  const startDirectSession = () => createSession.mutate({ slug }, {
    onSuccess: (session) => navigate(`/projects/${slug}/sessions/${session.sessionId}`, {
      state: { focusComposer: true },
    }),
  });
  const recoverFilters = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("q");
    next.delete("source");
    setSearchParams(next, { replace: true });
    requestAnimationFrame(() => filterInputRef.current?.focus());
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-base" aria-label="Runs inventory">
      <header className="flex min-h-[58px] shrink-0 items-center gap-2 border-b border-border-default bg-bg-surface py-2.5 pl-[66px] pr-3 min-[981px]:px-[18px]">
        <div className="min-w-0">
          <p className="text-[9px] font-semibold uppercase leading-3 tracking-[0.08em] text-text-tertiary">Operations</p>
          <h1 className="mt-px text-[17px] font-semibold leading-5 tracking-[-0.025em] text-text-primary">Runs <span className={`ml-1 inline-flex min-h-[19px] items-center rounded-full px-2 align-middle text-[10px] font-semibold tabular-nums ${activeCount === undefined ? "bg-bg-muted text-text-tertiary" : "bg-signal-field text-signal-foreground"}`}>{activeCount === undefined ? "— active" : `${activeCount} active`}</span></h1>
        </div>
      </header>
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border-default bg-bg-base px-3 pb-[14px] pt-[18px] min-[641px]:flex min-[641px]:flex-col min-[641px]:items-stretch min-[721px]:flex-row min-[721px]:items-center min-[721px]:gap-[14px] min-[721px]:px-6 min-[721px]:pt-7">
        <div className="contents min-[641px]:flex min-[641px]:min-w-0 min-[641px]:flex-1 min-[641px]:items-center min-[641px]:gap-2">
          <label className="group col-span-2 flex h-11 w-full min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-[color-mix(in_srgb,var(--bg-base)_82%,var(--bg-surface))] py-0 pl-3 pr-1 text-text-tertiary shadow-[inset_0_1px_0_rgb(255_255_255/3%)] transition-[border-color,background-color,box-shadow] duration-[var(--motion-fast)] hover:border-border-default hover:bg-bg-elevated focus-within:border-brand focus-within:bg-bg-elevated focus-within:[box-shadow:var(--focus)] min-[641px]:col-span-1 min-[641px]:h-[38px] min-[641px]:flex-1 min-[721px]:max-w-[430px]">
            <Search className="shrink-0 transition-colors duration-[var(--motion-fast)] group-focus-within:text-brand" size={14} aria-hidden="true" />
            <span className="sr-only">Filter Sessions</span>
            <input ref={filterInputRef} type="search" aria-label="Filter Sessions" value={query} onChange={(event) => setParam("q", event.target.value)} placeholder="Filter Sessions…" autoComplete="off" spellCheck={false} className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent px-0.5 text-[16px] text-text-primary outline-none placeholder:text-text-tertiary [&::-webkit-search-cancel-button]:appearance-none min-[641px]:text-[12px]" />
            {query ? <button ref={clearFilterRef} type="button" aria-label="Clear Session filter" onClick={() => setParam("q", "")} className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"><X size={12} aria-hidden="true" /></button> : null}
          </label>
          <SessionSourcePicker
            nextFocusRef={newSessionRef}
            onChange={(value) => setParam("source", value === "all" ? "" : value)}
            previousFocusRef={query ? clearFilterRef : filterInputRef}
            value={source}
          />
        </div>
          <button
            ref={newSessionRef}
            type="button"
            onClick={startDirectSession}
            disabled={createSession.isPending}
            className="inline-flex h-11 min-h-11 items-center justify-center gap-[7px] rounded-md border border-border-default bg-bg-surface px-[11px] text-[11.5px] font-semibold text-text-tertiary transition-[background-color,border-color,color] duration-[var(--motion-fast)] hover:border-border-strong hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:cursor-not-allowed disabled:opacity-45 min-[641px]:h-[34px] min-[641px]:min-h-[34px]"
          >
            <Plus size={14} aria-hidden="true" /> New Session
          </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1128px] px-3 pb-16 pt-[18px] min-[721px]:px-6 min-[721px]:pt-[22px]">
          {createSession.error && <p role="alert" className="text-[12px] text-error">{createSession.error.message}</p>}
          {!inventory.isSuccess && !inventory.error ? <p className="py-10 text-center text-[13px] text-text-tertiary">Loading Sessions…</p> : null}
          {inventory.error ? <p className="py-10 text-center text-[13px] text-error">Failed to load Sessions</p> : null}
          {inventory.isSuccess && !stateReady ? <p className="py-10 text-center text-[13px] text-text-tertiary">Loading Session state…</p> : null}
          {stateReady && filtered.length === 0 ? (
            <SessionInventoryEmptyState
              onRecover={recoverFilters}
              query={query}
              source={source}
              totalCount={inventory.data?.length ?? 0}
            />
          ) : null}
          {stateReady ? (["needs-you", "running", "recent"] as const).map((group) => groups[group].length > 0 ? (
            <SessionGroup
              key={group}
              group={group}
              items={groups[group]}
              activityBySessionId={activityBySessionId}
              attentionSessionIds={attentionSessionIds}
              attentionLabelsBySessionId={attentionLabelsBySessionId}
              automationNames={automationNames}
              todoNames={todoNames}
              slug={slug}
            />
          ) : null) : null}
        </div>
      </div>
    </div>
  );
}

const SESSION_SOURCE_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "todo", label: "Todo" },
  { value: "automation", label: "Automation" },
  { value: "direct", label: "Direct" },
] as const satisfies readonly { value: SessionSourceFilter; label: string }[];

function SessionSourcePicker({ value, onChange, previousFocusRef, nextFocusRef }: {
  value: SessionSourceFilter;
  onChange: (value: SessionSourceFilter) => void;
  previousFocusRef: RefObject<HTMLElement | null>;
  nextFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, SESSION_SOURCE_OPTIONS.findIndex((option) => option.value === value));
  const focusOption = useCallback((index: number) => {
    requestAnimationFrame(() => optionRefs.current[index]?.focus());
  }, []);
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);
  const openPicker = useCallback((edge: "selected" | "first" | "last" = "selected") => {
    setOpen(true);
    const index = edge === "first"
      ? 0
      : edge === "last"
        ? SESSION_SOURCE_OPTIONS.length - 1
        : selectedIndex;
    focusOption(index);
  }, [focusOption, selectedIndex]);
  const commit = (nextValue: SessionSourceFilter) => {
    onChange(nextValue);
    close(true);
  };

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !shellRef.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [close, open]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = optionRefs.current.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = SESSION_SOURCE_OPTIONS[currentIndex];
      if (option) commit(option.value);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      close();
      if (event.shiftKey) previousFocusRef.current?.focus();
      else nextFocusRef.current?.focus();
      return;
    }
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? SESSION_SOURCE_OPTIONS.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1 + SESSION_SOURCE_OPTIONS.length) % SESSION_SOURCE_OPTIONS.length
          : event.key === "ArrowUp"
            ? (currentIndex - 1 + SESSION_SOURCE_OPTIONS.length) % SESSION_SOURCE_OPTIONS.length
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    optionRefs.current[nextIndex]?.focus();
  };

  return (
    <div
      ref={shellRef}
      className="relative h-11 w-[150px] shrink-0 min-[641px]:h-[38px] min-[641px]:w-[168px]"
      data-testid="session-source-picker"
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        close();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-controls="session-source-options"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Session source: ${SESSION_SOURCE_OPTIONS[selectedIndex]?.label ?? "All sources"}`}
        className="grid h-full w-full grid-cols-[14px_minmax(0,1fr)_12px] items-center gap-[7px] rounded-[7px] border border-border-control bg-bg-elevated px-[9px] text-left text-text-secondary transition-[border-color,background-color,color,box-shadow] duration-[var(--motion-fast)] hover:border-border-strong hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"
        onClick={() => { if (open) close(); else openPicker(); }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
          event.preventDefault();
          openPicker(event.key === "ArrowUp" || event.key === "End" ? "last" : event.key === "Home" ? "first" : "selected");
        }}
      >
        <Filter size={14} className="text-text-muted" aria-hidden="true" />
        <span className="min-w-0 truncate text-[16px] font-semibold min-[641px]:text-[11px]">{SESSION_SOURCE_OPTIONS[selectedIndex]?.label ?? "All sources"}</span>
        <ChevronDown size={12} className={`text-text-tertiary transition-transform duration-[var(--motion-fast)] ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open ? (
        <div
          id="session-source-options"
          role="listbox"
          aria-label="Session source"
          className="absolute left-0 top-[calc(100%+6px)] z-[42] grid w-full gap-0.5 rounded-[8px] border border-border-default bg-bg-overlay p-1 shadow-[var(--elevation-popover)]"
          onKeyDown={handleMenuKeyDown}
        >
          {SESSION_SOURCE_OPTIONS.map((option, index) => {
            const selected = option.value === value;
            return (
              <button
                ref={(element) => { optionRefs.current[index] = element; }}
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={-1}
                className={`relative grid min-h-[35px] w-full grid-cols-[minmax(0,1fr)_14px] items-center gap-2 rounded-[5px] px-[9px] text-left text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:z-[1] focus-visible:bg-bg-hover focus-visible:text-text-primary focus-visible:outline-none [@media(pointer:coarse)]:min-h-11 ${selected ? "bg-selection-field text-text-primary shadow-[inset_2px_0_0_var(--brand)] focus-visible:[box-shadow:var(--focus),inset_2px_0_0_var(--brand)]" : "focus-visible:[box-shadow:var(--focus)]"}`}
                onClick={() => commit(option.value)}
              >
                <span>{option.label}</span>
                <Check size={13} className={selected ? "text-brand" : "opacity-0"} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function SessionInventoryEmptyState({ totalCount, query, source, onRecover }: {
  totalCount: number;
  query: string;
  source: SessionSourceFilter;
  onRecover: () => void;
}) {
  const presentation = presentSessionInventoryEmptyState(totalCount, query, source);
  if (totalCount === 0) {
    return (
      <section className="flex min-h-[220px] flex-col items-start justify-center border-y border-border-subtle px-2 py-[42px] text-left">
        <strong className="text-[12px] font-semibold text-text-secondary">{presentation.title}</strong>
        <p className="mt-[3px] max-w-[52ch] text-[12px] leading-[1.6] text-text-tertiary">{presentation.detail}</p>
      </section>
    );
  }
  return (
    <section className="my-[18px] flex min-h-[74px] items-center justify-between gap-[18px] border-y border-border-subtle px-0.5 py-3.5 text-left">
      <span className="min-w-0 text-[12px] leading-[1.55] text-text-tertiary" role="status" aria-live="polite">
        <strong className="mb-[3px] block font-semibold text-text-secondary">{presentation.title}</strong>
        {presentation.detail}
      </span>
      <button type="button" onClick={onRecover} className="inline-flex min-h-[34px] shrink-0 items-center justify-center rounded-md border border-border-default bg-transparent px-[11px] text-[11.5px] font-semibold text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(pointer:coarse)]:min-h-11">
        {presentation.recoveryLabel}
      </button>
    </section>
  );
}

function SessionGroup({ group, items, activityBySessionId, attentionSessionIds, attentionLabelsBySessionId, automationNames, todoNames, slug }: {
  group: SessionInventoryGroup;
  items: readonly ProjectSessionInventoryItem[];
  activityBySessionId: ReadonlyMap<string, SessionFamilyActivity>;
  attentionSessionIds: ReadonlySet<string>;
  attentionLabelsBySessionId: ReadonlyMap<string, "Inspection" | "Permission" | "Question">;
  automationNames: ReadonlyMap<string, string>;
  todoNames: ReadonlyMap<string, string>;
  slug: string;
}) {
  const title = group === "needs-you" ? "Needs you" : group === "running" ? "Running" : "Recent";
  return (
    <section className="[&+section]:mt-[26px]" aria-labelledby={`sessions-${group}`}>
      <header className="flex min-h-[29px] items-baseline justify-between gap-3 border-b border-border-default px-[7px] pb-2">
        <h2 id={`sessions-${group}`} className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.06em] text-text-primary"><span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${group === "needs-you" ? "bg-warning" : group === "running" ? "bg-signal" : "bg-success"}`} />{title}</h2>
        <span className="text-[10.5px] tabular-nums text-text-tertiary">{items.length}</span>
      </header>
      <div>
        {items.map((item) => (
          <SessionRow
            activity={activityBySessionId.get(item.session.sessionId) ?? "idle"}
            attentionLabel={attentionSessionIds.has(item.session.sessionId)
              ? attentionLabelsBySessionId.get(item.session.sessionId) ?? "Question"
              : undefined}
            automationNames={automationNames}
            group={group}
            item={item}
            key={item.session.sessionId}
            slug={slug}
            todoNames={todoNames}
          />
        ))}
      </div>
    </section>
  );
}

function SessionRow({ activity, attentionLabel, automationNames, group, item, slug, todoNames }: {
  activity: SessionFamilyActivity;
  attentionLabel?: "Inspection" | "Permission" | "Question";
  automationNames: ReadonlyMap<string, string>;
  group: SessionInventoryGroup;
  item: ProjectSessionInventoryItem;
  slug: string;
  todoNames: ReadonlyMap<string, string>;
}) {
  const session = item.session;
  const source = session.source;
  const statusPresentation = presentSessionInventoryStatus(item, activity, attentionLabel);
  const agentLabel = session.agentName
    ? `${session.agentName.slice(0, 1).toUpperCase()}${session.agentName.slice(1)}`
    : "Lead";
  const sourceType = source.kind === "todo" ? "Todo" : source.kind === "automation" ? "Automation" : "Direct";
  const sourceContext = source.kind === "todo"
    ? `${todoNames.get(source.todoId) ?? source.todoId} · ${agentLabel}`
    : source.kind === "automation"
      ? `${automationNames.get(source.automationId) ?? source.automationId} · ${agentLabel}`
      : agentLabel;
  const sourceLabel = `${sourceType} · ${sourceContext}`;
  const execution = item.latestExecution;
  const isRunning = statusPresentation.kind === "running";
  const elapsed = useElapsedTime({
    startedAt: execution?.startedAt ?? session.updatedAt,
    active: isRunning,
    endedAt: execution?.endedAt,
  });

  return (
    <Link
      key={session.sessionId}
      to={`/projects/${slug}/sessions/${session.sessionId}`}
      aria-label={`${session.title || "Untitled Session"}, ${sourceLabel}, ${statusPresentation.label}${statusPresentation.detail ? `, ${statusPresentation.detail}` : ""}`}
      data-session-row-presentation="flat"
      className="workbench-row-lift grid min-h-[72px] grid-cols-[27px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border-subtle px-2 py-2.5 text-text-secondary transition-[background-color,color,transform] duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand min-[721px]:min-h-[66px] min-[721px]:grid-cols-[30px_minmax(0,1fr)_112px_14px]"
    >
      <span className={`grid h-[27px] w-[27px] place-items-center rounded-[7px] border shadow-[inset_0_1px_0_rgb(255_255_255/3%)] ${sessionStatusOrbitClass(statusPresentation.kind)}`}>
        <StatusGlyph kind={statusPresentation.kind} size={12} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-semibold leading-[1.35] text-text-primary">{session.title || "Untitled Session"}</span>
        <span className="mt-1 block truncate text-[11.5px] leading-[1.35] text-text-tertiary">
          <span className="inline-flex items-center align-baseline text-[9px] font-bold uppercase tracking-[0.04em]">{sourceType}</span>
          <span aria-hidden="true"> · </span>{sourceContext}
        </span>
      </span>
      <span className={`items-center justify-end gap-2 justify-self-end ${isRunning ? "hidden min-[721px]:flex" : "flex"}`}>
        {isRunning ? (
          <span className="whitespace-nowrap font-mono text-[10px] tabular-nums text-text-tertiary">{elapsed}</span>
        ) : (
          <>
            <span className={`inline-flex min-h-[23px] items-center whitespace-nowrap rounded-[5px] border px-2 text-[10.5px] font-semibold ${sessionStatusLabelClass(statusPresentation.kind)}`} title={statusPresentation.detail ? `${statusPresentation.label} · ${statusPresentation.detail}` : statusPresentation.label}>
              {statusPresentation.label}
            </span>
            {group === "recent" ? <span className="hidden whitespace-nowrap font-mono text-[10px] tabular-nums text-text-tertiary min-[721px]:inline"><RelativeTime timestamp={session.updatedAt} /></span> : null}
          </>
        )}
      </span>
      <ChevronRight size={13} className="hidden text-text-tertiary min-[721px]:block" aria-hidden="true" />
    </Link>
  );
}

function sessionStatusOrbitClass(kind: VisualStatusKind): string {
  if (kind === "needs_you" || kind === "blocked" || kind === "warning") return "border-[color:color-mix(in_srgb,var(--warning)_30%,var(--border-subtle))] bg-[linear-gradient(160deg,var(--warning-field),color-mix(in_srgb,var(--warning-field)_78%,var(--bg-muted)))]";
  if (kind === "running" || kind === "loading") return "border-[color:color-mix(in_srgb,var(--signal)_28%,var(--border-subtle))] bg-[linear-gradient(160deg,var(--signal-field),color-mix(in_srgb,var(--signal-field)_78%,var(--bg-muted)))]";
  if (kind === "failed") return "border-[color:color-mix(in_srgb,var(--error)_28%,var(--border-subtle))] bg-error-field";
  if (kind === "completed") return "border-[color:color-mix(in_srgb,var(--success)_24%,var(--border-subtle))] bg-[linear-gradient(160deg,var(--success-field),color-mix(in_srgb,var(--success-field)_78%,var(--bg-muted)))]";
  return "border-border-subtle bg-[linear-gradient(160deg,color-mix(in_srgb,var(--bg-elevated)_62%,var(--bg-muted)),var(--bg-muted))]";
}

function sessionStatusLabelClass(kind: VisualStatusKind): string {
  if (kind === "needs_you" || kind === "blocked" || kind === "warning") return "border-[color:color-mix(in_srgb,var(--warning)_24%,transparent)] bg-warning-field text-warning";
  if (kind === "running" || kind === "loading") return "border-[color:color-mix(in_srgb,var(--signal)_24%,transparent)] bg-signal-field text-signal-foreground";
  if (kind === "failed") return "border-[color:color-mix(in_srgb,var(--error)_24%,transparent)] bg-error-field text-error";
  if (kind === "completed") return "border-[color:color-mix(in_srgb,var(--success)_22%,transparent)] bg-success-field text-success";
  return "border-transparent bg-bg-elevated text-text-tertiary";
}

function activityLabel(activity: SessionFamilyActivity): string {
  return activity === "resuming" ? "Resuming" : activity === "stopping" ? "Stopping" : activity === "running" ? "Running" : "Idle";
}
