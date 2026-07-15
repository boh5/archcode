import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Archive,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  ExternalLink,
  Lightbulb,
  MessageCircle,
  Play,
  Plus,
  RotateCcw,
  Save,
  Send,
  Sparkles,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useActivateProjectTodo,
  useArchiveProjectTodo,
  useCreateProjectTodo,
  useDiscussProjectTodo,
  useRestoreProjectTodo,
  useReturnProjectTodoToReady,
  useUpdateProjectTodo,
} from "../api/mutations";
import { useAutomations, useGoals, useProjectTodos, useSessions } from "../api/queries";
import type { ProjectTodo, ProjectTodoActivationKind, ProjectTodoUpdateInput } from "../api/types";
import { useSessionRuntimeFamilies, useSessionRuntimeInitialized, runtimeFamilyKey } from "../store/session-runtime-store";

type View = "board" | "rejected" | "archived";
type ProjectTodoStatus = ProjectTodo["status"];
type TodoLane = "idea" | "ready" | "in_progress" | "done";

const STATUS_LABELS: Record<ProjectTodoStatus, string> = {
  idea: "Idea",
  ready: "Ready",
  done: "Done",
  rejected: "Rejected",
};

const STATUS_STYLES: Record<ProjectTodoStatus, string> = {
  idea: "border-warning/40 bg-warning/10 text-warning",
  ready: "border-info/40 bg-info-muted text-info",
  done: "border-success/40 bg-success-muted text-success",
  rejected: "border-error/40 bg-error-muted text-error",
};

const LANE_PRESENTATION: Record<TodoLane, {
  title: string;
  hint: string;
  emptyTitle: string;
  emptyHint: string;
  Icon: LucideIcon;
  iconClass: string;
  badgeClass: string;
}> = {
  idea: {
    title: "Ideas",
    hint: "Capture first, shape later",
    emptyTitle: "No ideas yet",
    emptyHint: "Capture an idea above.",
    Icon: Sparkles,
    iconClass: "bg-warning-muted text-warning",
    badgeClass: "bg-warning-muted text-warning",
  },
  ready: {
    title: "Ready",
    hint: "Clear enough to hand off",
    emptyTitle: "Nothing ready",
    emptyHint: "Shape an idea to move it here.",
    Icon: CircleDot,
    iconClass: "bg-info-muted text-info",
    badgeClass: "bg-info-muted text-info",
  },
  in_progress: {
    title: "In Progress",
    hint: "Connected to active work",
    emptyTitle: "No active work",
    emptyHint: "Start a ready Todo to link work.",
    Icon: Play,
    iconClass: "bg-accent-muted text-accent",
    badgeClass: "bg-accent-muted text-accent",
  },
  done: {
    title: "Done",
    hint: "Explicitly completed",
    emptyTitle: "Nothing completed",
    emptyHint: "Completed Todos stay visible here.",
    Icon: CheckCircle2,
    iconClass: "bg-success-muted text-success",
    badgeClass: "bg-success-muted text-success",
  },
};

export function ProjectTodosRoute() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: todos, isLoading, error } = useProjectTodos(slug);
  const { data: sessions, isLoading: sessionsLoading } = useSessions(slug);
  const { data: goals, isLoading: goalsLoading } = useGoals(slug);
  const { data: automations, isLoading: automationsLoading } = useAutomations(slug);
  const runtimeFamilies = useSessionRuntimeFamilies();
  const runtimeInitialized = useSessionRuntimeInitialized(slug);
  const [view, setView] = useState<View>("board");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const createTodo = useCreateProjectTodo();
  const selectedTodoId = searchParams.get("todo");
  const appliedSelectionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedTodoId) {
      appliedSelectionRef.current = null;
      return;
    }
    if (appliedSelectionRef.current === selectedTodoId) return;
    const selectedTodo = todos?.find((todo) => todo.id === selectedTodoId);
    if (!selectedTodo) return;
    setView(selectedTodo.archivedAt !== undefined
      ? "archived"
      : selectedTodo.status === "rejected"
        ? "rejected"
        : "board");
    setExpandedId(selectedTodo.id);
    appliedSelectionRef.current = selectedTodoId;
  }, [selectedTodoId, todos]);

  const visibleTodos = useMemo(() => {
    const list = todos ?? [];
    if (view === "archived") return list.filter((todo) => todo.archivedAt !== undefined);
    if (view === "rejected") return list.filter((todo) => todo.archivedAt === undefined && todo.status === "rejected");
    return list.filter((todo) => todo.archivedAt === undefined && todo.status !== "rejected");
  }, [todos, view]);

  const groups = useMemo(() => deriveProjectTodoGroups(visibleTodos), [visibleTodos]);

  const handleCreate = () => {
    const title = newTitle.trim();
    if (!title) {
      setCreateError("Title is required");
      return;
    }
    setCreateError(null);
    createTodo.mutate({ slug, input: { title } }, {
      onSuccess: (result) => {
        setNewTitle("");
        setView("board");
        setExpandedId(result.todo.id);
      },
      onError: (cause) => setCreateError(cause instanceof Error ? cause.message : "Failed to create Todo"),
    });
  };

  if (isLoading) return <div className="flex h-full items-center justify-center text-sm text-text-tertiary">Loading Todos…</div>;
  if (error) return <div className="flex h-full items-center justify-center text-sm text-error">Failed to load Todos</div>;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg-base">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-4 border-b border-border-subtle bg-bg-surface px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent-subtle shadow-sm">
            <Lightbulb size={16} className="text-accent" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-text-primary">Todos</h1>
              {(todos?.length ?? 0) > 0 && (
                <span className="rounded-full bg-bg-active px-2 py-0.5 text-[10px] font-medium text-text-tertiary">
                  {todos?.length} total
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-[11.5px] text-text-tertiary">Capture intent, shape it with Shaper, then hand it to execution.</p>
          </div>
        </div>
        <div className="flex items-center gap-0.5 rounded-md border border-border-default bg-bg-base p-1 shadow-sm" role="group" aria-label="Todo views">
          <ViewButton active={view === "board"} onClick={() => setView("board")} label="Board" />
          <ViewButton active={view === "rejected"} onClick={() => setView("rejected")} label="Rejected" />
          <ViewButton active={view === "archived"} onClick={() => setView("archived")} label="Archived" />
        </div>
      </header>

      <div className="shrink-0 px-5 pt-4">
        <div className="mx-auto flex max-w-[1500px] items-center gap-2 rounded-lg border border-border-default bg-bg-surface p-2 shadow-sm transition-[border-color,box-shadow] focus-within:border-accent/50 focus-within:shadow-md">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-elevated text-text-tertiary">
            <Plus size={15} aria-hidden="true" />
          </div>
          <input
            aria-label="New Todo title"
            value={newTitle}
            onChange={(event) => { setNewTitle(event.target.value); setCreateError(null); }}
            onKeyDown={(event) => { if (event.key === "Enter") handleCreate(); }}
            placeholder="What do you want to remember or explore later?"
            className="min-w-0 flex-1 bg-transparent px-1.5 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none"
          />
          <button type="button" aria-label="New Todo" onClick={handleCreate} disabled={createTodo.isPending} className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-accent bg-accent px-3.5 py-2 text-[11.5px] font-semibold text-bg-base shadow-sm transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
            <Plus size={13} aria-hidden="true" /> New Todo
          </button>
        </div>
        {createError && <p role="alert" className="mx-auto mt-1.5 max-w-[1500px] px-1 text-xs text-error">{createError}</p>}
      </div>

      <main className="flex-1 overflow-auto px-5 pb-6 pt-4">
        {view === "board" ? (
          <div className="mx-auto grid min-w-[880px] max-w-[1500px] grid-cols-4 items-start gap-3">
            <TodoGroup lane="idea" todos={groups.idea} expandedId={expandedId} onExpand={setExpandedId} slug={slug} navigate={navigate} sessions={sessions} goals={goals} automations={automations} runtimeFamilies={runtimeFamilies} sessionsLoading={sessionsLoading} goalsLoading={goalsLoading} automationsLoading={automationsLoading} runtimeInitialized={runtimeInitialized} />
            <TodoGroup lane="ready" todos={groups.ready} expandedId={expandedId} onExpand={setExpandedId} slug={slug} navigate={navigate} sessions={sessions} goals={goals} automations={automations} runtimeFamilies={runtimeFamilies} sessionsLoading={sessionsLoading} goalsLoading={goalsLoading} automationsLoading={automationsLoading} runtimeInitialized={runtimeInitialized} />
            <TodoGroup lane="in_progress" todos={groups.in_progress} expandedId={expandedId} onExpand={setExpandedId} slug={slug} navigate={navigate} sessions={sessions} goals={goals} automations={automations} runtimeFamilies={runtimeFamilies} sessionsLoading={sessionsLoading} goalsLoading={goalsLoading} automationsLoading={automationsLoading} runtimeInitialized={runtimeInitialized} />
            <TodoGroup lane="done" todos={groups.done} expandedId={expandedId} onExpand={setExpandedId} slug={slug} navigate={navigate} sessions={sessions} goals={goals} automations={automations} runtimeFamilies={runtimeFamilies} sessionsLoading={sessionsLoading} goalsLoading={goalsLoading} automationsLoading={automationsLoading} runtimeInitialized={runtimeInitialized} />
          </div>
        ) : (
          <div className="mx-auto max-w-5xl">
            <section className="rounded-lg border border-border-subtle bg-bg-surface p-3 shadow-sm">
              <div className="mb-3 flex items-center gap-2.5 px-1 py-0.5">
                <div className={`flex h-8 w-8 items-center justify-center rounded-md ${view === "rejected" ? "bg-error-muted text-error" : "bg-bg-active text-text-secondary"}`}>
                  {view === "rejected" ? <Ban size={15} aria-hidden="true" /> : <Archive size={15} aria-hidden="true" />}
                </div>
                <div>
                  <h2 className="text-[13px] font-semibold text-text-primary">{view === "rejected" ? "Rejected Todos" : "Archived Todos"}</h2>
                  <p className="text-[11px] text-text-tertiary">{view === "rejected" ? "Ideas intentionally declined, with their reasoning preserved." : "Inactive items kept out of the active workflow."}</p>
                </div>
              </div>
              {visibleTodos.length === 0 ? (
                <div className="flex min-h-36 flex-col items-center justify-center rounded-md border border-dashed border-border-default bg-bg-base/50 px-6 text-center">
                  {view === "rejected" ? <Ban size={18} className="mb-2 text-text-muted" aria-hidden="true" /> : <Archive size={18} className="mb-2 text-text-muted" aria-hidden="true" />}
                  <p className="text-[12px] font-medium text-text-secondary">Nothing here yet</p>
                  <p className="mt-0.5 text-[11px] text-text-muted">Items moved here stay recoverable.</p>
                </div>
              ) : (
                <div className="grid gap-2.5 md:grid-cols-2">
                  {visibleTodos.map((todo) => <TodoCard key={todo.id} todo={todo} expanded={expandedId === todo.id} onExpand={() => setExpandedId(expandedId === todo.id ? null : todo.id)} slug={slug} navigate={navigate} sessions={sessions} goals={goals} automations={automations} runtimeFamilies={runtimeFamilies} sessionsLoading={sessionsLoading} goalsLoading={goalsLoading} automationsLoading={automationsLoading} runtimeInitialized={runtimeInitialized} />)}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

export type ProjectTodoBoardGroups = Record<TodoLane, ProjectTodo[]>;

export function deriveProjectTodoGroups(todos: readonly ProjectTodo[]): ProjectTodoBoardGroups {
  const grouped: ProjectTodoBoardGroups = { idea: [], ready: [], in_progress: [], done: [] };
  for (const todo of todos) {
    if (todo.status === "idea") grouped.idea.push(todo);
    else if (todo.status === "done") grouped.done.push(todo);
    else if (todo.activation) grouped.in_progress.push(todo);
    else grouped.ready.push(todo);
  }
  return grouped;
}

function TodoGroup({ lane, todos, expandedId, onExpand, ...cardProps }: TodoGroupProps) {
  const presentation = LANE_PRESENTATION[lane];
  const { Icon } = presentation;
  return (
    <section className="min-w-0 rounded-lg border border-border-subtle bg-bg-surface p-2.5 shadow-sm" aria-label={presentation.title}>
      <div className="flex items-center justify-between gap-2 px-0.5 pb-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${presentation.iconClass}`}>
            <Icon size={13} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-[12.5px] font-semibold text-text-primary">{presentation.title}</h2>
            <p className="truncate text-[10.5px] text-text-tertiary">{presentation.hint}</p>
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums ${presentation.badgeClass}`}>{todos.length}</span>
      </div>
      <div className="flex flex-col gap-2">
        {todos.length === 0 ? (
          <div className="flex min-h-28 flex-col items-center justify-center rounded-md border border-dashed border-border-default bg-bg-base/40 px-3 text-center">
            <Icon size={16} className="mb-2 text-text-muted" aria-hidden="true" />
            <p className="text-[11px] font-medium text-text-tertiary">{presentation.emptyTitle}</p>
            <p className="mt-0.5 text-[10px] leading-4 text-text-muted">{presentation.emptyHint}</p>
          </div>
        ) : todos.map((todo) => <TodoCard key={todo.id} todo={todo} expanded={expandedId === todo.id} onExpand={() => onExpand(expandedId === todo.id ? null : todo.id)} {...cardProps} />)}
      </div>
    </section>
  );
}

interface TodoGroupProps {
  lane: TodoLane;
  todos: ProjectTodo[];
  expandedId: string | null;
  onExpand: (id: string | null) => void;
  slug: string;
  navigate: ReturnType<typeof useNavigate>;
  sessions?: import("../api/types").SessionSummary[];
  goals?: import("../api/types").GoalState[];
  automations?: import("../api/types").Automation[];
  runtimeFamilies: ReturnType<typeof useSessionRuntimeFamilies>;
  sessionsLoading: boolean;
  goalsLoading: boolean;
  automationsLoading: boolean;
  runtimeInitialized: boolean;
}

interface TodoCardProps extends Omit<TodoGroupProps, "lane" | "todos" | "expandedId" | "onExpand"> {
  todo: ProjectTodo;
  expanded: boolean;
  onExpand: () => void;
}

function TodoCard({ todo, expanded, onExpand, slug, navigate, sessions, goals, automations, runtimeFamilies, sessionsLoading, goalsLoading, automationsLoading, runtimeInitialized }: TodoCardProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(todo.title);
  const [body, setBody] = useState(todo.body);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [rejectionError, setRejectionError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const update = useUpdateProjectTodo();
  const discuss = useDiscussProjectTodo();
  const activate = useActivateProjectTodo();
  const archive = useArchiveProjectTodo();
  const restore = useRestoreProjectTodo();
  const returnToReady = useReturnProjectTodoToReady();

  const isArchived = todo.archivedAt !== undefined;
  const inProgress = todo.activation !== undefined && todo.status !== "done" && !isArchived;
  const linkedSession = todo.activation?.kind === "session" && todo.activation.resourceId ? sessions?.find((session) => session.sessionId === todo.activation?.resourceId) : undefined;
  const linkedGoal = todo.activation?.kind === "goal" && todo.activation.resourceId ? goals?.find((goal) => goal.id === todo.activation?.resourceId) : undefined;
  const linkedAutomation = todo.activation?.kind === "automation" && todo.activation.resourceId ? automations?.find((automation) => automation.id === todo.activation?.resourceId) : undefined;
  const sessionActivity = linkedSession ? runtimeFamilies[runtimeFamilyKey(slug, linkedSession.sessionId)]?.activity : undefined;

  useEffect(() => {
    if (editing) return;
    setTitle(todo.title);
    setBody(todo.body);
    setBaseRevision(null);
  }, [editing, todo.body, todo.revision, todo.title]);

  const mutate = (fn: () => void) => { setActionError(null); fn(); };
  const showError = (cause: unknown) => setActionError(cause instanceof Error ? cause.message : "Action failed");

  const beginEditing = () => {
    setTitle(todo.title);
    setBody(todo.body);
    setBaseRevision(todo.revision);
    setEditing(true);
  };
  const save = () => {
    if (baseRevision === null) return;
    mutate(() => update.mutate({ slug, todoId: todo.id, input: { expectedRevision: baseRevision, patch: { title: title.trim(), body } } }, { onSuccess: () => setEditing(false), onError: showError }));
  };
  const setStatus = (status: "idea" | "ready" | "rejected" | "done", rejectionReason?: string) => mutate(() => update.mutate({ slug, todoId: todo.id, input: { expectedRevision: todo.revision, patch: { status, ...(rejectionReason ? { rejectionReason } : {}) } } as ProjectTodoUpdateInput }, { onError: showError }));
  const startDiscussion = () => mutate(() => discuss.mutate({ slug, todoId: todo.id, expectedRevision: todo.revision }, { onSuccess: (result) => navigate(`/projects/${slug}/sessions/${result.sessionId}`), onError: showError }));
  const startActivation = (kind: ProjectTodoActivationKind) => {
    setActionError(null);
    void activate.mutateAsync({ slug, todoId: todo.id, kind, expectedRevision: todo.revision })
      .then((result) => navigate(`/projects/${slug}/sessions/${result.sessionId}`))
      .catch(showError);
  };
  const runArchive = () => mutate(() => archive.mutate({ slug, todoId: todo.id, expectedRevision: todo.revision }, { onError: showError }));
  const runRestore = () => mutate(() => restore.mutate({ slug, todoId: todo.id, expectedRevision: todo.revision }, { onError: showError }));
  const runReturn = () => mutate(() => returnToReady.mutate({ slug, todoId: todo.id, expectedRevision: todo.revision }, { onError: showError }));
  const beginRejecting = () => {
    setRejectReason("");
    setRejectionError(null);
    setRejecting(true);
  };
  const submitRejection = () => {
    const reason = rejectReason.trim();
    if (!reason) {
      setRejectionError("Rejection reason is required");
      return;
    }
    setRejecting(false);
    setRejectionError(null);
    setStatus("rejected", reason);
  };

  return (
    <article className={`overflow-hidden rounded-md border bg-bg-base shadow-sm transition-[border-color,box-shadow] ${expanded ? "border-accent/45 shadow-md" : "border-border-default hover:border-border-strong hover:shadow-md"}`} data-testid={`todo-${todo.id}`}>
      <button type="button" className="block w-full px-3 pb-2.5 pt-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50" onClick={onExpand} aria-expanded={expanded}>
        <span className="flex items-center justify-between gap-2">
          <span className={`rounded-sm border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.04em] ${STATUS_STYLES[todo.status]}`}>{inProgress ? "In Progress" : STATUS_LABELS[todo.status]}</span>
          <ChevronDown size={14} className={`shrink-0 text-text-muted transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
        </span>
        <span className="mt-2 block min-w-0 text-[13px] font-semibold leading-[1.35] tracking-[-0.005em] text-text-primary">{todo.title}</span>
      </button>
      {!expanded && todo.body && <p className="line-clamp-2 px-3 pb-2 text-[10.5px] leading-4 text-text-tertiary">{todo.body}</p>}
      {!expanded && todo.rejectionReason && <p className="line-clamp-2 px-3 pb-2 text-[10.5px] leading-4 text-error">Rejected: {todo.rejectionReason}</p>}
      {!expanded && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3">
          <CollapsedTodoAssociations
            todo={todo}
            slug={slug}
            linkedSession={linkedSession}
            linkedGoal={linkedGoal}
            linkedAutomation={linkedAutomation}
            sessionActivity={sessionActivity}
            sessionsLoading={sessionsLoading}
            goalsLoading={goalsLoading}
            automationsLoading={automationsLoading}
            runtimeInitialized={runtimeInitialized}
          />
          {isArchived ? (
            <CompactPrimaryAction label="Restore" onClick={runRestore} disabled={restore.isPending} />
          ) : todo.status === "rejected" ? (
            <CompactPrimaryAction label="Restore to Idea" onClick={() => setStatus("idea")} />
          ) : todo.status === "idea" ? (
            <CompactPrimaryAction label={todo.discussionSessionId ? "Continue Discussion" : "Discuss"} onClick={startDiscussion} disabled={discuss.isPending} />
          ) : inProgress ? (
            <CompactPrimaryAction label="Return to Ready" onClick={runReturn} disabled={returnToReady.isPending} />
          ) : todo.status === "ready" ? (
            <CompactPrimaryAction label="Start Session" onClick={() => startActivation("session")} disabled={activate.isPending} />
          ) : (
            <CompactPrimaryAction label="Reopen" onClick={() => setStatus("ready")} disabled={update.isPending} />
          )}
        </div>
      )}
      {expanded && (
        <div className="space-y-3 border-t border-border-subtle bg-bg-surface/60 px-3 py-3">
          {editing ? (
            <div className="space-y-2">
              <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Todo title" className="w-full rounded-md border border-border-default bg-bg-base px-2.5 py-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-muted" />
              <textarea value={body} onChange={(event) => setBody(event.target.value)} aria-label="Todo body" rows={4} className="w-full resize-y rounded-md border border-border-default bg-bg-base px-2.5 py-2 text-[11px] leading-5 text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-muted" />
              <div className="flex gap-2"><TodoActionButton onClick={save} variant="primary"><Save size={12} /> Save</TodoActionButton><TodoActionButton onClick={() => setEditing(false)}><X size={12} /> Cancel</TodoActionButton></div>
            </div>
          ) : (
            <>{todo.body && <p className="whitespace-pre-wrap text-[11px] leading-5 text-text-secondary">{todo.body}</p>}{todo.rejectionReason && <div className="rounded-md border border-error/30 bg-error-muted px-2.5 py-2 text-[11px] leading-4 text-error"><span className="font-semibold">Rejected:</span> {todo.rejectionReason}</div>}<div className="flex flex-wrap gap-1.5"><TodoActionButton onClick={beginEditing}>Edit</TodoActionButton>{!isArchived && todo.status !== "done" && <TodoActionButton onClick={startDiscussion} disabled={discuss.isPending} variant="accent"><MessageCircle size={12} /> {todo.discussionSessionId ? "Continue Discussion" : "Discuss"}</TodoActionButton>}</div></>
          )}

          {todo.activation && (
            <div className="rounded-md border border-border-subtle bg-bg-base px-2.5 py-2.5 text-[10.5px] text-text-tertiary">
              <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-text-secondary"><Play size={11} /> Activation · {todo.activation.kind}</div>
              <div className="flex flex-wrap items-center gap-2">
                {todo.activation.resourceId === undefined ? (
                  <><Link className="inline-flex items-center gap-1 text-accent hover:underline" to={`/projects/${slug}/sessions/${todo.activation.sourceSessionId}`}>Source Session <ExternalLink size={10} /></Link><span>Preparing resource…</span></>
                ) : todo.activation.kind === "session" ? (
                  linkedSession ? <Link className="inline-flex items-center gap-1 text-accent hover:underline" to={`/projects/${slug}/sessions/${linkedSession.sessionId}`}>Session · {runtimeInitialized ? sessionActivity ?? "idle" : "loading"}<ExternalLink size={10} /></Link> : <span>{sessionsLoading ? "Loading resource…" : "Deleted"}</span>
                ) : todo.activation.kind === "goal" ? (
                  linkedGoal ? <Link className="inline-flex items-center gap-1 text-accent hover:underline" to={`/projects/${slug}/goals/${linkedGoal.id}`}>Goal · {linkedGoal.status}<ExternalLink size={10} /></Link> : <span>{goalsLoading ? "Loading resource…" : "Deleted"}</span>
                ) : linkedAutomation ? (
                  <Link className="inline-flex items-center gap-1 text-accent hover:underline" to={`/projects/${slug}/automations/${linkedAutomation.id}`}>Automation · {linkedAutomation.status}<ExternalLink size={10} /></Link>
                ) : <span>{automationsLoading ? "Loading resource…" : "Deleted"}</span>}
              </div>
            </div>
          )}

          {!isArchived && todo.status === "idea" && (
            <div className="flex flex-wrap gap-1.5">
              <TodoActionButton onClick={() => setStatus("ready")} variant="info"><Check size={12} /> Mark Ready</TodoActionButton>
              <RejectButton onClick={beginRejecting} />
            </div>
          )}
          {!isArchived && todo.status === "rejected" && (
            <div className="flex flex-wrap gap-1.5"><TodoActionButton onClick={() => setStatus("idea")}><RotateCcw size={12} /> Restore to Idea</TodoActionButton></div>
          )}
          {!isArchived && todo.status === "ready" && !todo.activation && (
            <div className="flex flex-wrap gap-1.5">
              <TodoActionButton onClick={() => startActivation("session")} disabled={activate.isPending} variant="primary"><Send size={12} /> Start Session</TodoActionButton>
              <TodoActionButton onClick={() => startActivation("goal")} disabled={activate.isPending}>Start Goal</TodoActionButton>
              <TodoActionButton onClick={() => startActivation("automation")} disabled={activate.isPending}>Create Automation</TodoActionButton>
              <TodoActionButton onClick={() => setStatus("idea")}><RotateCcw size={12} /> Move to Idea</TodoActionButton>
              <RejectButton onClick={beginRejecting} />
              <TodoActionButton onClick={() => setStatus("done")} variant="success"><Check size={12} /> Mark Done</TodoActionButton>
            </div>
          )}
          {!isArchived && inProgress && (
            <div className="flex flex-wrap gap-1.5">
              <TodoActionButton onClick={runReturn} disabled={returnToReady.isPending} variant="warning">Return to Ready</TodoActionButton>
              <TodoActionButton onClick={() => setStatus("done")} variant="success"><Check size={12} /> Mark Done</TodoActionButton>
            </div>
          )}
          {!isArchived && todo.status === "done" && <TodoActionButton onClick={() => setStatus("ready")} variant="info"><RotateCcw size={12} /> Reopen</TodoActionButton>}
          {!isArchived && !inProgress && <TodoActionButton onClick={runArchive} variant="quiet"><Archive size={12} /> Archive</TodoActionButton>}
          {isArchived && <TodoActionButton onClick={runRestore}><RotateCcw size={12} /> Restore</TodoActionButton>}
          {!isArchived && (todo.status === "idea" || (todo.status === "ready" && !todo.activation)) && rejecting && (
            <div className="rounded-md border border-error/30 bg-error-muted p-2.5">
              <textarea autoFocus aria-label="Rejection reason" aria-describedby={rejectionError ? `todo-${todo.id}-rejection-error` : undefined} value={rejectReason} onChange={(event) => { setRejectReason(event.target.value); setRejectionError(null); }} placeholder="Why should this Todo be rejected?" rows={2} className="w-full resize-none bg-transparent text-[11px] leading-4 text-text-primary outline-none placeholder:text-text-muted" />
              {rejectionError && <p id={`todo-${todo.id}-rejection-error`} role="alert" className="mt-1 text-[10.5px] text-error">{rejectionError}</p>}
              <div className="mt-2 flex justify-end gap-1.5"><TodoActionButton onClick={() => { setRejecting(false); setRejectionError(null); }} variant="quiet">Cancel</TodoActionButton><TodoActionButton onClick={submitRejection} variant="danger">Reject Todo</TodoActionButton></div>
            </div>
          )}
        </div>
      )}
      {actionError && <p role="alert" className="border-t border-error/20 bg-error-muted px-3 py-2 text-[10.5px] text-error">{actionError}</p>}
    </article>
  );
}

function CompactPrimaryAction({ label, onClick, disabled = false }: { label: string; onClick: () => void; disabled?: boolean }) {
  return <TodoActionButton onClick={onClick} disabled={disabled} variant="accent">{label}</TodoActionButton>;
}

function CollapsedTodoAssociations({ todo, slug, linkedSession, linkedGoal, linkedAutomation, sessionActivity, sessionsLoading, goalsLoading, automationsLoading, runtimeInitialized }: {
  todo: ProjectTodo;
  slug: string;
  linkedSession?: import("../api/types").SessionSummary;
  linkedGoal?: import("../api/types").GoalState;
  linkedAutomation?: import("../api/types").Automation;
  sessionActivity?: import("@archcode/protocol").SessionFamilyActivity;
  sessionsLoading: boolean;
  goalsLoading: boolean;
  automationsLoading: boolean;
  runtimeInitialized: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 text-[9.5px] text-text-tertiary" aria-label="Todo associations">
      {todo.discussionSessionId && <Link className="inline-flex items-center gap-1 rounded-sm bg-accent-subtle px-1.5 py-1 text-accent transition-colors hover:bg-accent-muted" to={`/projects/${slug}/sessions/${todo.discussionSessionId}`}><MessageCircle size={10} /> Discussion</Link>}
      {todo.activation && (
        todo.activation.resourceId === undefined ? (
          <Link className="inline-flex items-center gap-1 rounded-sm bg-accent-subtle px-1.5 py-1 text-accent transition-colors hover:bg-accent-muted" to={`/projects/${slug}/sessions/${todo.activation.sourceSessionId}`}><Play size={10} /> Activation · {todo.activation.kind} · preparing</Link>
        ) : todo.activation.kind === "session" ? (
          linkedSession ? <Link className="inline-flex items-center gap-1 rounded-sm bg-accent-subtle px-1.5 py-1 text-accent transition-colors hover:bg-accent-muted" to={`/projects/${slug}/sessions/${linkedSession.sessionId}`}><Play size={10} /> Activation · Session · {runtimeInitialized ? sessionActivity ?? "idle" : "loading"}</Link> : <span><Play size={10} className="inline" /> Activation · Session · {sessionsLoading ? "loading" : "deleted"}</span>
        ) : todo.activation.kind === "goal" ? (
          linkedGoal ? <Link className="inline-flex items-center gap-1 rounded-sm bg-accent-subtle px-1.5 py-1 text-accent transition-colors hover:bg-accent-muted" to={`/projects/${slug}/goals/${linkedGoal.id}`}><Play size={10} /> Activation · Goal · {linkedGoal.status}</Link> : <span><Play size={10} className="inline" /> Activation · Goal · {goalsLoading ? "loading" : "deleted"}</span>
        ) : linkedAutomation ? (
          <Link className="inline-flex items-center gap-1 rounded-sm bg-accent-subtle px-1.5 py-1 text-accent transition-colors hover:bg-accent-muted" to={`/projects/${slug}/automations/${linkedAutomation.id}`}><Play size={10} /> Activation · Automation · {linkedAutomation.status}</Link>
        ) : <span><Play size={10} className="inline" /> Activation · Automation · {automationsLoading ? "loading" : "deleted"}</span>
      )}
      {!todo.discussionSessionId && !todo.activation && <span className="py-1 text-text-muted">No linked work yet</span>}
    </div>
  );
}

function ViewButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`rounded-sm px-2.5 py-1.5 text-[10.5px] font-medium transition-colors ${active ? "bg-bg-active text-text-primary shadow-sm" : "text-text-tertiary hover:bg-bg-hover hover:text-text-primary"}`}>{label}</button>;
}

function RejectButton({ onClick }: { onClick: () => void }) {
  return <TodoActionButton onClick={onClick} variant="dangerQuiet"><Trash2 size={12} /> Reject</TodoActionButton>;
}

type TodoActionVariant = "primary" | "accent" | "info" | "success" | "warning" | "danger" | "dangerQuiet" | "secondary" | "quiet";

const TODO_ACTION_STYLES: Record<TodoActionVariant, string> = {
  primary: "border-accent bg-accent text-bg-base shadow-sm hover:bg-accent-hover",
  accent: "border-accent/30 bg-accent-subtle text-accent hover:bg-accent-muted",
  info: "border-info/30 bg-info-muted text-info hover:border-info/50",
  success: "border-success/30 bg-success-muted text-success hover:border-success/50",
  warning: "border-warning/30 bg-warning-muted text-warning hover:border-warning/50",
  danger: "border-error bg-error text-white shadow-sm hover:brightness-110",
  dangerQuiet: "border-error/30 bg-transparent text-error hover:bg-error-muted",
  secondary: "border-border-default bg-bg-elevated text-text-secondary hover:border-border-strong hover:bg-bg-hover hover:text-text-primary",
  quiet: "border-transparent bg-transparent text-text-tertiary hover:bg-bg-hover hover:text-text-secondary",
};

function TodoActionButton({ children, onClick, disabled = false, variant = "secondary" }: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: TodoActionVariant;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[10.5px] font-medium transition-[background-color,border-color,color] disabled:cursor-not-allowed disabled:opacity-50 ${TODO_ACTION_STYLES[variant]}`}
    >
      {children}
    </button>
  );
}
