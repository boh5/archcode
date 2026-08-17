import { useMemo } from "react";
import { ChevronDown, ChevronRight, Filter, Plus, Search, X } from "lucide-react";
import { projectTodoContentExcerpt, rootSessionSourceTodoId, type SessionFamilyActivity } from "@archcode/protocol";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useCreateSession } from "../api/mutations";
import { useAutomationInventory, useProjectTodos, useSessionInventory } from "../api/queries";
import type { ProjectSessionInventoryItem } from "../api/types";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { RelativeTime, useElapsedTime } from "../components/primitives/TemporalText";
import { runtimeFamilyKey, useSessionRuntimeFamilies } from "../store/session-runtime-store";
import { hitlAttentionLabelsByRootSession, useAttentionVisibleScopedHitl } from "../store/hitl-store";
import type { VisualStatusKind } from "../lib/status-visuals";

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
    if (attentionSessionIds.has(id) || executionNeedsAttention(item)) groups["needs-you"].push(item);
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
  const attentionLabelsBySessionId = useMemo(() => hitlAttentionLabelsByRootSession(attention), [attention]);
  const attentionSessionIds = useMemo(() => new Set(attentionLabelsBySessionId.keys()), [attentionLabelsBySessionId]);
  const groups = useMemo(() => classifySessionInventory(filtered, activityBySessionId, attentionSessionIds), [activityBySessionId, attentionSessionIds, filtered]);
  const activeCount = groups["needs-you"].length + groups.running.length;
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-base" aria-label="Runs inventory">
      <header className="flex min-h-[58px] shrink-0 items-center gap-2 border-b border-border-default bg-bg-surface py-2.5 pl-[66px] pr-3 min-[981px]:px-[18px]">
        <div className="min-w-0">
          <p className="text-[9px] font-semibold uppercase leading-3 tracking-[0.08em] text-text-tertiary">Operations</p>
          <h1 className="mt-px text-[17px] font-semibold leading-5 tracking-[-0.025em] text-text-primary">Runs <span className="ml-1 inline-flex min-h-[19px] items-center rounded-full bg-signal-field px-2 align-middle text-[10px] font-semibold tabular-nums text-signal-foreground">{activeCount} active</span></h1>
        </div>
      </header>
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border-default bg-bg-base px-3 pb-[14px] pt-[18px] min-[641px]:flex min-[641px]:flex-col min-[641px]:items-stretch min-[721px]:flex-row min-[721px]:items-center min-[721px]:gap-[14px] min-[721px]:px-6 min-[721px]:pt-7">
        <div className="contents min-[641px]:flex min-[641px]:min-w-0 min-[641px]:flex-1 min-[641px]:items-center min-[641px]:gap-2">
          <label className="group col-span-2 flex h-11 w-full min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-[color-mix(in_srgb,var(--bg-base)_82%,var(--bg-surface))] py-0 pl-3 pr-1 text-text-tertiary shadow-[inset_0_1px_0_rgb(255_255_255/3%)] transition-[border-color,background-color,box-shadow] duration-[var(--motion-fast)] hover:border-border-default hover:bg-bg-elevated focus-within:border-brand focus-within:bg-bg-elevated focus-within:[box-shadow:var(--focus)] min-[641px]:col-span-1 min-[641px]:h-[38px] min-[641px]:flex-1 min-[721px]:max-w-[430px]">
            <Search className="shrink-0 transition-colors duration-[var(--motion-fast)] group-focus-within:text-brand" size={14} aria-hidden="true" />
            <span className="sr-only">Filter Sessions</span>
            <input type="search" value={query} onChange={(event) => setParam("q", event.target.value)} placeholder="Filter Sessions…" autoComplete="off" spellCheck={false} className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent px-0.5 text-[16px] text-text-primary outline-none placeholder:text-text-tertiary [&::-webkit-search-cancel-button]:appearance-none min-[641px]:text-[12px]" />
            {query ? <button type="button" aria-label="Clear Session filter" onClick={() => setParam("q", "")} className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"><X size={12} aria-hidden="true" /></button> : null}
          </label>
          <SessionSourcePicker value={source} onChange={(value) => setParam("source", value === "all" ? "" : value)} />
        </div>
          <button
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
  { value: "all", label: "All sources" },
  { value: "todo", label: "Todo" },
  { value: "automation", label: "Automation" },
  { value: "direct", label: "Direct" },
] as const satisfies readonly { value: SessionSourceFilter; label: string }[];

function SessionSourcePicker({ value, onChange }: { value: SessionSourceFilter; onChange: (value: SessionSourceFilter) => void }) {
  return (
    <label className="relative grid h-11 w-[150px] shrink-0 grid-cols-[14px_minmax(108px,auto)_12px] items-center gap-[7px] rounded-md border border-border-subtle bg-bg-base px-[9px] text-text-secondary transition-[border-color,background-color,box-shadow] duration-[var(--motion-fast)] hover:border-border-default focus-within:border-brand focus-within:bg-bg-elevated focus-within:[box-shadow:var(--focus)] min-[641px]:h-[38px] min-[641px]:w-[168px]" data-testid="session-source-picker">
      <Filter size={14} className="text-text-muted" aria-hidden="true" />
      <span className="sr-only">Session source</span>
      <select aria-label="Session source" value={value} onChange={(event) => onChange(event.target.value as SessionSourceFilter)} className="h-full min-w-0 appearance-none bg-transparent text-[16px] font-semibold outline-none min-[641px]:text-[11px]">
        {SESSION_SOURCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <ChevronDown size={12} className="pointer-events-none text-text-tertiary" aria-hidden="true" />
    </label>
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
        <h2 id={`sessions-${group}`} className="text-[11px] font-bold uppercase tracking-[0.06em] text-text-primary">{title}</h2>
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
      data-session-row-presentation={isRunning ? "featured" : "standard"}
      className={`workbench-row-lift grid min-h-[72px] grid-cols-[27px_minmax(0,1fr)_auto] items-center gap-3 py-2.5 text-text-secondary transition-[background-color,color,transform] duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand min-[721px]:min-h-[66px] min-[721px]:grid-cols-[30px_minmax(0,1fr)_auto_auto_14px] ${isRunning
        ? "my-[5px] rounded-[8px] border border-[color:color-mix(in_srgb,var(--brand)_26%,var(--border-subtle))] bg-[color:color-mix(in_srgb,var(--brand-field)_44%,transparent)] px-[10px] shadow-[inset_2px_0_0_var(--brand)]"
        : "border-b border-border-subtle px-2"
      }`}
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
      {isRunning ? <span aria-hidden="true" /> : (
        <span className={`${group === "needs-you" ? "inline-flex" : "hidden min-[721px]:inline-flex"} min-h-[23px] items-center whitespace-nowrap rounded-[5px] border px-2 text-[9.5px] font-semibold ${sessionStatusLabelClass(statusPresentation.kind)}`} title={statusPresentation.detail ? `${statusPresentation.label} · ${statusPresentation.detail}` : statusPresentation.label}>
          {statusPresentation.label}
        </span>
      )}
      <span className="hidden whitespace-nowrap font-mono text-[10px] tabular-nums text-text-tertiary min-[721px]:inline">
        {isRunning ? elapsed : group === "recent" ? <RelativeTime timestamp={session.updatedAt} /> : null}
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

function executionNeedsAttention(item: ProjectSessionInventoryItem): boolean {
  return item.latestExecution?.status === "failed" || item.latestExecution?.status === "timed_out" || item.latestExecution?.status === "max_steps";
}

function activityLabel(activity: SessionFamilyActivity): string {
  return activity === "resuming" ? "Resuming" : activity === "stopping" ? "Stopping" : activity === "running" ? "Running" : "Idle";
}
