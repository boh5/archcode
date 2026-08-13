import { useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, Check, ChevronRight, Filter, Layers3, ListTodo, Search, Workflow, X } from "lucide-react";
import { projectTodoContentExcerpt, type SessionFamilyActivity } from "@archcode/protocol";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useCreateSession } from "../api/mutations";
import { useAutomationInventory, useProjectTodos, useSessionInventory } from "../api/queries";
import type { ProjectSessionInventoryItem } from "../api/types";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { RelativeTime, useElapsedTime } from "../components/primitives/TemporalText";
import { runtimeFamilyKey, useSessionRuntimeFamilies } from "../store/session-runtime-store";
import { useAttentionVisibleScopedHitl } from "../store/hitl-store";
import type { VisualStatusKind } from "../lib/status-visuals";
import { PrimaryActionButton } from "../components/primitives/PrimaryActionButton";

export type SessionInventoryGroup = "needs-you" | "running" | "recent";
export type SessionSourceFilter = "all" | "todo" | "automation" | "direct";

export function sessionAttentionLabels(entries: readonly {
  rootSessionId: string;
  view: { source: { type: "tool_permission" | "ask_user" }; requiresInspection?: true };
}[]): ReadonlyMap<string, "Inspection" | "Permission" | "Question"> {
  const labels = new Map<string, "Inspection" | "Permission" | "Question">();
  for (const entry of entries) {
    const label = entry.view.requiresInspection === true
      ? "Inspection"
      : entry.view.source.type === "tool_permission" ? "Permission" : "Question";
    if (label === "Inspection" || label === "Permission" || !labels.has(entry.rootSessionId)) labels.set(entry.rootSessionId, label);
  }
  return labels;
}

export function classifySessionInventory(
  items: readonly ProjectSessionInventoryItem[],
  activityBySessionId: ReadonlyMap<string, SessionFamilyActivity>,
  attentionSessionIds: ReadonlySet<string>,
): Record<SessionInventoryGroup, ProjectSessionInventoryItem[]> {
  const groups: Record<SessionInventoryGroup, ProjectSessionInventoryItem[]> = { "needs-you": [], running: [], recent: [] };
  for (const item of items) {
    const id = item.session.sessionId;
    if (attentionSessionIds.has(id) || activityBySessionId.get(id) === "waiting_for_human" || executionNeedsAttention(item)) groups["needs-you"].push(item);
    else if ((activityBySessionId.get(id) ?? "idle") !== "idle" || item.latestExecution?.status === "running") groups.running.push(item);
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
  if (activity === "waiting_for_human") return { label: "Needs you", kind: "needs_you", detail: "Waiting for response" };
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
  const linkedTodoContent = sessionSource.kind === "todo" ? todoContents.get(sessionSource.todoId) : undefined;
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

export function ProjectSessionsRoute() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const inventory = useSessionInventory(slug);
  const { data: todos = [] } = useProjectTodos(slug);
  const automationInventory = useAutomationInventory(slug);
  const runtimeFamilies = useSessionRuntimeFamilies();
  const attention = useAttentionVisibleScopedHitl([slug]);
  const createSession = useCreateSession();
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
  const attentionLabelsBySessionId = useMemo(() => sessionAttentionLabels(attention), [attention]);
  const attentionSessionIds = useMemo(() => new Set(attentionLabelsBySessionId.keys()), [attentionLabelsBySessionId]);
  const groups = useMemo(() => classifySessionInventory(filtered, activityBySessionId, attentionSessionIds), [activityBySessionId, attentionSessionIds, filtered]);
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-base" aria-label="Sessions inventory">
      <header className="grid min-h-[58px] shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border-default bg-bg-surface px-3 pb-3 pt-2.5 min-[761px]:flex min-[761px]:px-6 min-[761px]:py-2.5">
          <label className="group col-span-2 flex h-11 w-full max-w-none min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-[color-mix(in_srgb,var(--bg-base)_82%,var(--bg-surface))] py-0 pl-3 pr-1 text-text-tertiary shadow-[inset_0_1px_0_rgb(255_255_255/3%)] transition-[border-color,background-color,box-shadow] duration-[var(--motion-hover)] hover:border-border-default hover:bg-bg-elevated focus-within:border-brand focus-within:bg-bg-elevated focus-within:[box-shadow:var(--focus)] min-[761px]:col-span-1 min-[761px]:h-[38px] min-[761px]:max-w-[420px] min-[761px]:flex-[0_1_420px]">
            <Search className="shrink-0 transition-colors duration-[var(--motion-hover)] group-focus-within:text-brand" size={14} aria-hidden="true" />
            <span className="sr-only">Filter Sessions</span>
            <input type="search" value={query} onChange={(event) => setParam("q", event.target.value)} placeholder="Filter Sessions…" autoComplete="off" spellCheck={false} className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent px-0.5 text-[16px] text-text-primary outline-none placeholder:text-text-tertiary [&::-webkit-search-cancel-button]:appearance-none min-[761px]:text-[12px]" />
            {query ? <button type="button" aria-label="Clear Session filter" onClick={() => setParam("q", "")} className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"><X size={12} aria-hidden="true" /></button> : null}
          </label>
          <SessionSourcePicker value={source} onChange={(value) => setParam("source", value === "all" ? "" : value)} />
          <PrimaryActionButton
            onClick={startDirectSession}
            disabled={createSession.isPending}
            className="ml-0 min-[761px]:ml-auto"
          >
            New Session
          </PrimaryActionButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1080px] px-3 pb-10 pt-[18px] min-[761px]:px-6 min-[761px]:pb-14 min-[761px]:pt-6">
          {createSession.error && <p role="alert" className="text-[12px] text-error">{createSession.error.message}</p>}
          {inventory.isLoading ? <p className="py-10 text-center text-[13px] text-text-tertiary">Loading Sessions…</p> : null}
          {inventory.error ? <p className="py-10 text-center text-[13px] text-error">Failed to load Sessions</p> : null}
          {!inventory.isLoading && !inventory.error && filtered.length === 0 ? (
            <p className="py-16 text-center text-[13px] text-text-tertiary">{sessionInventoryEmptyMessage(inventory.data?.length ?? 0)}</p>
          ) : null}
          {(["needs-you", "running", "recent"] as const).map((group) => groups[group].length > 0 ? (
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
          ) : null)}
        </div>
      </div>
    </div>
  );
}

const SESSION_SOURCE_OPTIONS = [
  { value: "all", label: "All sources", description: "Every Session origin", Icon: Layers3 },
  { value: "todo", label: "Todo", description: "Started from a Todo", Icon: ListTodo },
  { value: "automation", label: "Automation", description: "Started by Automation", Icon: Workflow },
  { value: "direct", label: "Direct", description: "Started directly", Icon: AppWindow },
] as const satisfies readonly { value: SessionSourceFilter; label: string; description: string; Icon: typeof Layers3 }[];

function SessionSourcePicker({ value, onChange }: { value: SessionSourceFilter; onChange: (value: SessionSourceFilter) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = SESSION_SOURCE_OPTIONS.find((option) => option.value === value) ?? SESSION_SOURCE_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const options = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    if (options.length === 0) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? options.length - 1
        : event.key === "ArrowDown" ? (current + 1 + options.length) % options.length
          : (current - 1 + options.length) % options.length;
    options[next]?.focus();
  };

  return (
    <div ref={rootRef} className="relative h-11 w-[150px] shrink-0 min-[761px]:h-9 min-[761px]:w-[142px] [@media(pointer:coarse)]:h-11" data-testid="session-source-picker">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Session source: ${selected.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="session-source-menu"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
            return;
          }
          if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) return;
          event.preventDefault();
          setOpen(true);
          requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
        }}
        className={`grid h-full w-full grid-cols-[15px_minmax(0,1fr)_12px] items-center gap-2 rounded-md border px-[11px] text-left text-[16px] font-[650] leading-[1.55] text-text-secondary transition-[border-color,background-color,box-shadow] duration-[var(--motion-hover)] hover:border-border-default hover:bg-bg-elevated focus-visible:outline-none min-[761px]:text-[11px] ${open ? "!border-brand bg-bg-elevated [box-shadow:var(--focus)]" : "border-border-subtle bg-bg-base focus-visible:border-brand focus-visible:bg-bg-elevated focus-visible:[box-shadow:var(--focus)]"}`}
      >
        <Filter size={14} className={open ? "text-brand" : "text-text-muted"} aria-hidden="true" />
        <span className="truncate">{selected.label}</span>
        <ChevronRight size={12} className={`text-text-tertiary transition-transform duration-[var(--motion-icon)] motion-reduce:transition-none ${open ? "-rotate-90" : "rotate-90"}`} aria-hidden="true" />
      </button>

      {open ? <div
        ref={menuRef}
        id="session-source-menu"
        role="menu"
        aria-label="Session source"
        onKeyDown={moveFocus}
        className="absolute left-0 top-[calc(100%+6px)] z-30 w-[min(220px,calc(100vw-24px))] rounded-lg border border-border-default bg-bg-overlay p-1.5 leading-[1.55] tracking-[-0.006em] shadow-md animate-overlay-enter motion-reduce:animate-none"
      >
        <div className="border-b border-border-subtle px-2.5 pb-2 pt-1.5">
          <strong className="block text-[11px] font-[680] leading-[1.55] text-text-primary">Session source</strong>
          <span className="mt-0.5 block text-[10px] leading-4 text-text-tertiary">Narrow Sessions by how they started.</span>
        </div>
        <div className="pt-1">
          {SESSION_SOURCE_OPTIONS.map((option) => {
            const checked = option.value === value;
            const Icon = option.Icon;
            return <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
                triggerRef.current?.focus();
              }}
              className="grid min-h-11 w-full grid-cols-[16px_minmax(0,1fr)_14px] items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-text-secondary outline-none transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus:bg-bg-hover focus:text-text-primary"
              data-source-value={option.value}
            >
              <Icon size={15} className={checked ? "text-brand" : "text-text-muted"} aria-hidden="true" />
              <span className="min-w-0"><strong className="block text-[12px] font-[650] leading-[1.55]">{option.label}</strong><span className="mt-px block text-[10px] leading-4 text-text-tertiary">{option.description}</span></span>
              <Check size={14} className={checked ? "text-brand" : "invisible"} aria-hidden="true" />
            </button>;
          })}
        </div>
      </div> : null}
    </div>
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
    <section className="px-2 pb-2.5 pt-0.5 [&+section]:mt-7" aria-labelledby={`sessions-${group}`}>
      <header className="flex min-h-7 items-baseline justify-between gap-3 px-[3px] pb-2">
        <h2 id={`sessions-${group}`} className="text-[11px] font-[720] uppercase tracking-[0.055em] text-text-primary">{title}</h2>
        <span className="text-[10px] tabular-nums text-text-tertiary">{items.length}</span>
      </header>
      <div className="border-t border-border-default">
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
  const isRunning = group === "running" && (activity !== "idle" || execution?.status === "running");
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
      className="workbench-row-lift grid min-h-[74px] grid-cols-[14px_minmax(0,1fr)] items-center gap-[11px] border-b border-border-subtle px-1.5 py-3 text-text-secondary transition-[background-color,color,transform] duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand min-[521px]:min-h-[60px] min-[521px]:grid-cols-[14px_minmax(0,1fr)_auto] min-[761px]:px-3"
    >
      <StatusGlyph kind={statusPresentation.kind} size={10} />
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-[620] text-text-primary">{session.title || "Untitled Session"}</span>
        <span className="mt-[3px] block truncate text-[11.5px] text-text-tertiary">
          <span className="mr-1 inline-flex items-center align-baseline text-[9px] font-bold uppercase tracking-[0.04em]">{sourceType}</span>
          {sourceContext}
        </span>
      </span>
      <span className={`col-start-2 mt-[-3px] justify-self-start whitespace-nowrap text-[11px] font-[640] tabular-nums min-[521px]:col-start-auto min-[521px]:mt-0 min-[521px]:justify-self-end ${statusPresentation.kind === "failed" ? "font-[680] text-error" : statusPresentation.kind === "needs_you" ? "font-[680] text-warning" : statusPresentation.kind === "running" ? "text-signal-foreground" : statusPresentation.kind === "completed" ? "text-success" : "text-text-tertiary"}`} title={statusPresentation.detail ? `${statusPresentation.label} · ${statusPresentation.detail}` : statusPresentation.label}>
        {isRunning ? elapsed : statusPresentation.label}
        {group === "recent" && !isRunning ? <span> · <RelativeTime timestamp={session.updatedAt} /></span> : null}
      </span>
    </Link>
  );
}

function executionNeedsAttention(item: ProjectSessionInventoryItem): boolean {
  return item.latestExecution?.status === "failed" || item.latestExecution?.status === "timed_out" || item.latestExecution?.status === "max_steps";
}

function activityLabel(activity: SessionFamilyActivity): string {
  return activity === "resuming" ? "Resuming" : activity === "stopping" ? "Stopping" : activity === "running" ? "Running" : "Idle";
}
