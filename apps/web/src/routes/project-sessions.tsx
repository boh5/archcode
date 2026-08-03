import { useMemo } from "react";
import { Filter, Plus, Search } from "lucide-react";
import { projectTodoContentExcerpt, type SessionFamilyActivity } from "@archcode/protocol";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useCreateSession } from "../api/mutations";
import { useAutomationInventory, useProjectTodos, useSessionInventory } from "../api/queries";
import type { ProjectSessionInventoryItem } from "../api/types";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { RelativeTime } from "../components/primitives/TemporalText";
import { runtimeFamilyKey, useSessionRuntimeFamilies } from "../store/session-runtime-store";
import { useAttentionVisibleScopedHitl } from "../store/hitl-store";
import type { VisualStatusKind } from "../lib/status-visuals";

export type SessionInventoryGroup = "needs-you" | "running" | "recent";
export type SessionSourceFilter = "all" | "todo" | "automation" | "direct";

export function sessionAttentionLabels(entries: readonly {
  rootSessionId: string;
  view: { source: { type: "tool_permission" | "ask_user" } };
}[]): ReadonlyMap<string, "Permission" | "Question"> {
  const labels = new Map<string, "Permission" | "Question">();
  for (const entry of entries) {
    const label = entry.view.source.type === "tool_permission" ? "Permission" : "Question";
    if (label === "Permission" || !labels.has(entry.rootSessionId)) labels.set(entry.rootSessionId, label);
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
    if (attentionSessionIds.has(id) || executionNeedsAttention(item)) groups["needs-you"].push(item);
    else if ((activityBySessionId.get(id) ?? "idle") !== "idle") groups.running.push(item);
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
  attentionLabel?: "Permission" | "Question",
): { label: string; kind: VisualStatusKind } {
  if (attentionLabel !== undefined) return { label: attentionLabel, kind: "needs_you" };
  const execution = item.latestExecution;
  if (execution?.status === "failed") return { label: "Failed", kind: "failed" };
  if (execution?.status === "timed_out") return { label: "Timed out", kind: "failed" };
  if (activity !== "idle") return { label: activityLabel(activity), kind: "running" };
  if (execution === null) return { label: "Idle", kind: "idle" };
  if (execution.status === "running") return { label: "Running", kind: "running" };
  if (execution.status === "suspended") return { label: "Suspended", kind: "blocked" };
  if (execution.status === "completed") return { label: "Completed", kind: "completed" };
  if (execution.status === "max_steps") return { label: "Stopped · Max steps", kind: "failed" };
  const detail = execution.status === "aborted" ? "Aborted"
    : execution.status === "cancelled" ? "Cancelled"
      : "Interrupted";
  return { label: `Stopped · ${detail}`, kind: "stopped" };
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

  const todoNames = useMemo(() => new Map(todos.map((todo) => [todo.id, projectTodoContentExcerpt(todo.content)])), [todos]);
  const automationNames = useMemo(() => new Map((automationInventory.data ?? []).map((item) => [item.automation.id, item.automation.name])), [automationInventory.data]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (inventory.data ?? []).filter((item) => {
      const sessionSource = item.session.source;
      if (source !== "all" && sessionSource.kind !== source) return false;
      const parent = sessionSource.kind === "todo"
        ? todoNames.get(sessionSource.todoId) ?? sessionSource.todoId
        : sessionSource.kind === "automation"
          ? automationNames.get(sessionSource.automationId) ?? sessionSource.automationId
          : "Direct";
      return needle.length === 0 || [item.session.title, item.session.sessionId, sessionSource.kind, parent]
        .some((value) => value?.toLocaleLowerCase().includes(needle));
    });
  }, [automationNames, inventory.data, query, source, todoNames]);
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
    <div className="h-full overflow-y-auto bg-bg-base" aria-label="Sessions inventory">
      <div className="mx-auto w-full max-w-[1080px] px-4 pb-12 pt-4 min-[761px]:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 basis-full min-[560px]:basis-auto">
            <span className="sr-only">Filter Sessions</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setParam("q", event.target.value)}
              placeholder="Filter Sessions…"
              className="h-9 w-full rounded-sm border border-control-border bg-bg-elevated pl-9 pr-3 text-[13px] text-text-primary outline-none focus:border-brand focus:ring-2 focus:ring-brand-subtle [@media(pointer:coarse)]:h-11"
            />
          </label>
          <label className="relative">
            <span className="sr-only">Session source</span>
            <Filter className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={13} aria-hidden="true" />
            <select
              value={source}
              onChange={(event) => setParam("source", event.target.value === "all" ? "" : event.target.value)}
              className="h-9 rounded-sm border border-control-border bg-bg-elevated pl-8 pr-8 text-[12px] text-text-secondary outline-none focus:border-brand focus:ring-2 focus:ring-brand-subtle [@media(pointer:coarse)]:h-11"
            >
              <option value="all">All sources</option>
              <option value="todo">Todo</option>
              <option value="automation">Automation</option>
              <option value="direct">Direct</option>
            </select>
          </label>
          <button
            type="button"
            onClick={startDirectSession}
            disabled={createSession.isPending}
            className="ml-auto inline-flex h-9 items-center gap-2 rounded-sm bg-brand px-3 text-[12px] font-semibold text-brand-ink hover:bg-brand-hover disabled:opacity-50 [@media(pointer:coarse)]:h-11"
          >
            <Plus size={14} aria-hidden="true" /> New Session
          </button>
        </div>
        {createSession.error && <p role="alert" className="mt-2 text-[12px] text-error">{createSession.error.message}</p>}
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
  );
}

function SessionGroup({ group, items, activityBySessionId, attentionSessionIds, attentionLabelsBySessionId, automationNames, todoNames, slug }: {
  group: SessionInventoryGroup;
  items: readonly ProjectSessionInventoryItem[];
  activityBySessionId: ReadonlyMap<string, SessionFamilyActivity>;
  attentionSessionIds: ReadonlySet<string>;
  attentionLabelsBySessionId: ReadonlyMap<string, "Permission" | "Question">;
  automationNames: ReadonlyMap<string, string>;
  todoNames: ReadonlyMap<string, string>;
  slug: string;
}) {
  const title = group === "needs-you" ? "Needs you" : group === "running" ? "Running" : "Recent";
  return (
    <section className="mt-7" aria-labelledby={`sessions-${group}`}>
      <h2 id={`sessions-${group}`} className="pb-2 text-[12px] font-semibold text-text-secondary">{title}</h2>
      <div className="divide-y divide-border-subtle border-y border-border-subtle">
        {items.map((item) => {
          const session = item.session;
          const hasHitl = attentionSessionIds.has(session.sessionId);
          const hasFailedExecution = executionNeedsAttention(item);
          const activity = activityBySessionId.get(session.sessionId) ?? "idle";
          const statusPresentation = presentSessionInventoryStatus(
            item,
            activity,
            hasHitl ? attentionLabelsBySessionId.get(session.sessionId) ?? "Question" : undefined,
          );
          const source = session.source;
          const sourceLabel = source.kind === "todo"
            ? `Todo · ${todoNames.get(source.todoId) ?? source.todoId}`
            : source.kind === "automation"
              ? `Automation · ${automationNames.get(source.automationId) ?? source.automationId}`
              : "Direct · Lead";
          return (
            <Link key={session.sessionId} to={`/projects/${slug}/sessions/${session.sessionId}`} className="flex min-h-14 items-center gap-3 px-3 py-2.5 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand [@media(pointer:coarse)]:min-h-14">
              <StatusGlyph kind={statusPresentation.kind} size={14} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-text-primary">{session.title || "Untitled Session"}</span>
                <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">{sourceLabel} · {session.sessionId}</span>
              </span>
              <span className={`shrink-0 text-[11px] ${hasFailedExecution ? "font-semibold text-error" : hasHitl ? "font-semibold text-warning" : "text-text-tertiary"}`}>{statusPresentation.label}</span>
              <span className="hidden shrink-0 text-[11px] text-text-tertiary min-[680px]:inline"><RelativeTime timestamp={session.updatedAt} /></span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function executionNeedsAttention(item: ProjectSessionInventoryItem): boolean {
  return item.latestExecution?.status === "failed" || item.latestExecution?.status === "timed_out";
}

function activityLabel(activity: SessionFamilyActivity): string {
  return activity === "waiting_for_human" ? "Waiting" : activity === "resuming" ? "Resuming" : activity === "stopping" ? "Stopping" : activity === "running" ? "Running" : "Idle";
}
