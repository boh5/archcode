import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Archive,
  Ban,
  Check,
  ChevronDown,
  ExternalLink,
  Lightbulb,
  MessageCircle,
  Plus,
  RotateCcw,
  Save,
  Send,
  Trash2,
  X,
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
import { useAutomations, useProjectTodos, useSessions } from "../api/queries";
import type { ProjectTodo, ProjectTodoActivationKind, ProjectTodoUpdateInput } from "../api/types";
import { useSessionRuntimeFamilies, useSessionRuntimeInitialized, runtimeFamilyKey } from "../store/session-runtime-store";
import { ActivityArc } from "../components/primitives/ActivityArc";
import { STATUS_TONE_CLASS, type StatusTone } from "../lib/status-visuals";
import {
  PROJECT_TODO_DISCUSSION_PRESENTATION,
  PROJECT_TODO_LANE_PRESENTATIONS,
  presentProjectTodoAssociation,
  presentProjectTodoCard,
  type ProjectTodoAssociationPresentation,
  type ProjectTodoGlyph,
  type ProjectTodoLane,
} from "./project-todo-presentation";

type View = "board" | "rejected" | "archived";

export function ProjectTodosRoute() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: todos, isLoading, error } = useProjectTodos(slug);
  const { data: sessions, isLoading: sessionsLoading } = useSessions(slug);
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
      <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-4 border-b border-border-default bg-bg-surface px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-brand/25 bg-brand-subtle">
            <Lightbulb size={16} className="text-brand" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-[16px] font-semibold leading-[22px] text-text-primary">Todos</h1>
              {(todos?.length ?? 0) > 0 && (
                <span className="rounded-full bg-bg-active px-2 py-1 text-[11px] font-medium text-text-tertiary">
                  {todos?.length} total
                </span>
              )}
            </div>
            <p className="mt-1 truncate text-[13px] leading-5 text-text-tertiary">Capture intent, discuss it with Lead, then hand it to execution.</p>
          </div>
        </div>
        <div className="flex h-8 items-center gap-1 rounded-md border border-border-default bg-bg-base p-1" role="group" aria-label="Todo views">
          <ViewButton active={view === "board"} onClick={() => setView("board")} label="Board" />
          <ViewButton active={view === "rejected"} onClick={() => setView("rejected")} label="Rejected" />
          <ViewButton active={view === "archived"} onClick={() => setView("archived")} label="Archived" />
        </div>
      </header>

      <div className="shrink-0 px-5 pt-4">
        <div className="mx-auto flex max-w-[1500px] items-center gap-2 rounded-lg border border-border-control bg-bg-elevated p-2 transition-[border-color,box-shadow] focus-within:border-brand focus-within:ring-2 focus-within:ring-brand-muted">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-elevated text-text-tertiary">
            <Plus size={15} aria-hidden="true" />
          </div>
          <input
            aria-label="New Todo title"
            value={newTitle}
            onChange={(event) => { setNewTitle(event.target.value); setCreateError(null); }}
            onKeyDown={(event) => { if (event.key === "Enter") handleCreate(); }}
            placeholder="What do you want to remember or explore later?"
            className="min-w-0 flex-1 bg-transparent px-2 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none"
          />
          <button type="button" aria-label="New Todo" onClick={handleCreate} disabled={createTodo.isPending} className="inline-flex h-8 shrink-0 items-center gap-2 rounded-sm border border-brand bg-brand px-3 text-[12px] font-medium text-bg-base transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50">
            <Plus size={13} aria-hidden="true" /> New Todo
          </button>
        </div>
        {createError && <p role="alert" className="mx-auto mt-2 max-w-[1500px] px-1 text-xs text-error">{createError}</p>}
      </div>

      <main className="flex-1 overflow-auto px-5 pb-6 pt-4">
        {view === "board" ? (
          <div className="mx-auto grid max-w-[1500px] grid-cols-1 items-start gap-3 min-[800px]:grid-cols-2 min-[1200px]:grid-cols-4">
            <TodoGroup lane="idea" todos={groups.idea} expandedId={expandedId} onExpand={setExpandedId} slug={slug} navigate={navigate} sessions={sessions} automations={automations} runtimeFamilies={runtimeFamilies} sessionsLoading={sessionsLoading} automationsLoading={automationsLoading} runtimeInitialized={runtimeInitialized} />
            <TodoGroup lane="ready" todos={groups.ready} expandedId={expandedId} onExpand={setExpandedId} slug={slug} navigate={navigate} sessions={sessions} automations={automations} runtimeFamilies={runtimeFamilies} sessionsLoading={sessionsLoading} automationsLoading={automationsLoading} runtimeInitialized={runtimeInitialized} />
            <TodoGroup lane="in_progress" todos={groups.in_progress} expandedId={expandedId} onExpand={setExpandedId} slug={slug} navigate={navigate} sessions={sessions} automations={automations} runtimeFamilies={runtimeFamilies} sessionsLoading={sessionsLoading} automationsLoading={automationsLoading} runtimeInitialized={runtimeInitialized} />
            <TodoGroup lane="done" todos={groups.done} expandedId={expandedId} onExpand={setExpandedId} slug={slug} navigate={navigate} sessions={sessions} automations={automations} runtimeFamilies={runtimeFamilies} sessionsLoading={sessionsLoading} automationsLoading={automationsLoading} runtimeInitialized={runtimeInitialized} />
          </div>
        ) : (
          <div className="mx-auto max-w-5xl">
            <section className="border-t border-border-default pt-3">
              <div className="mb-3 flex items-center gap-3 px-1 py-1">
                <div className={`flex h-8 w-8 items-center justify-center rounded-md ${view === "rejected" ? "bg-error-muted text-error" : "bg-neutral-muted text-neutral"}`}>
                  {view === "rejected" ? <Ban size={15} aria-hidden="true" /> : <Archive size={15} aria-hidden="true" />}
                </div>
                <div>
                  <h2 className="text-[13px] font-semibold text-text-primary">{view === "rejected" ? "Rejected Todos" : "Archived Todos"}</h2>
                  <p className="text-[11px] text-text-tertiary">{view === "rejected" ? "Ideas intentionally declined, with their reasoning preserved." : "Inactive items kept out of the active workflow."}</p>
                </div>
              </div>
              {visibleTodos.length === 0 ? (
                <div className="flex min-h-16 flex-col items-center justify-center px-6 text-center">
                  {view === "rejected" ? <Ban size={18} className="mb-2 text-text-muted" aria-hidden="true" /> : <Archive size={18} className="mb-2 text-text-muted" aria-hidden="true" />}
                  <p className="text-[12px] font-medium text-text-secondary">Nothing here yet</p>
                  <p className="mt-1 text-[11px] text-text-tertiary">Items moved here stay recoverable.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 min-[800px]:grid-cols-2">
                  {visibleTodos.map((todo) => <TodoCard key={todo.id} todo={todo} expanded={expandedId === todo.id} onExpand={() => setExpandedId(expandedId === todo.id ? null : todo.id)} slug={slug} navigate={navigate} sessions={sessions} automations={automations} runtimeFamilies={runtimeFamilies} sessionsLoading={sessionsLoading} automationsLoading={automationsLoading} runtimeInitialized={runtimeInitialized} />)}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

export type ProjectTodoBoardGroups = Record<ProjectTodoLane, ProjectTodo[]>;

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
  const presentation = PROJECT_TODO_LANE_PRESENTATIONS[lane];
  const { Icon } = presentation;
  return (
    <section className="min-w-0" aria-label={presentation.title}>
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon size={14} className={STATUS_TONE_CLASS[presentation.tone]} aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-[12px] font-semibold leading-4 text-text-primary">{presentation.title}</h2>
            <p className="truncate text-[11px] leading-4 text-text-tertiary">{presentation.hint}</p>
          </div>
        </div>
        <span className="shrink-0 text-[10px] font-semibold leading-[14px] tabular-nums text-text-tertiary">{todos.length}</span>
      </div>
      <div className="flex flex-col gap-2 pt-2">
        {todos.length === 0 ? (
          <div className="flex min-h-16 flex-col items-center justify-center px-3 text-center">
            <Icon size={16} className={`mb-1 ${STATUS_TONE_CLASS[presentation.tone]}`} aria-hidden="true" />
            <p className="text-[11px] font-medium leading-4 text-text-tertiary">{presentation.emptyTitle}</p>
            <p className="mt-1 text-[11px] leading-4 text-text-tertiary">{presentation.emptyHint}</p>
          </div>
        ) : todos.map((todo) => <TodoCard key={todo.id} todo={todo} expanded={expandedId === todo.id} onExpand={() => onExpand(expandedId === todo.id ? null : todo.id)} {...cardProps} />)}
      </div>
    </section>
  );
}

interface TodoGroupProps {
  lane: ProjectTodoLane;
  todos: ProjectTodo[];
  expandedId: string | null;
  onExpand: (id: string | null) => void;
  slug: string;
  navigate: ReturnType<typeof useNavigate>;
  sessions?: import("../api/types").SessionSummary[];
  automations?: import("../api/types").Automation[];
  runtimeFamilies: ReturnType<typeof useSessionRuntimeFamilies>;
  sessionsLoading: boolean;
  automationsLoading: boolean;
  runtimeInitialized: boolean;
}

interface TodoCardProps extends Omit<TodoGroupProps, "lane" | "todos" | "expandedId" | "onExpand"> {
  todo: ProjectTodo;
  expanded: boolean;
  onExpand: () => void;
}

function TodoCard({ todo, expanded, onExpand, slug, navigate, sessions, automations, runtimeFamilies, sessionsLoading, automationsLoading, runtimeInitialized }: TodoCardProps) {
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
  const linkedAutomation = todo.activation?.kind === "automation" && todo.activation.resourceId ? automations?.find((automation) => automation.id === todo.activation?.resourceId) : undefined;
  const associationSessionId = todo.activation?.resourceId === undefined
    ? todo.activation?.sourceSessionId
    : linkedSession?.sessionId;
  const associationSessionActivity = associationSessionId && runtimeInitialized
    ? runtimeFamilies[runtimeFamilyKey(slug, associationSessionId)]?.activity ?? "idle"
    : undefined;
  const associationPresentation = todo.activation === undefined ? undefined : presentProjectTodoAssociation({
    resourceLoading: todo.activation.kind === "session" ? sessionsLoading : automationsLoading,
    runtimeInitialized,
    sessionActivity: associationSessionActivity,
    resourceId: todo.activation.resourceId,
    resourceAvailable: todo.activation.kind === "session" ? linkedSession !== undefined : linkedAutomation !== undefined,
    ...(linkedAutomation ? { automationStatus: linkedAutomation.status } : {}),
  });
  const cardPresentation = presentProjectTodoCard({
    status: todo.status,
    ...(todo.archivedAt === undefined ? {} : { archivedAt: todo.archivedAt }),
    hasActivation: todo.activation !== undefined,
  });

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
    <article className={`relative overflow-hidden rounded-md border bg-bg-surface transition-colors ${expanded ? "border-border-strong before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-brand" : "border-border-default hover:border-border-strong"}`} data-testid={`todo-${todo.id}`}>
      <button type="button" className="block w-full px-3 pb-3 pt-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/50" onClick={onExpand} aria-expanded={expanded}>
        <span className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 text-[11px] font-semibold leading-4 text-text-secondary">
            <TodoVisualGlyph Icon={cardPresentation.Icon} tone={cardPresentation.tone} label={cardPresentation.label} />
            {cardPresentation.label}
          </span>
          <ChevronDown size={14} className={`shrink-0 text-text-muted transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
        </span>
        <span className="mt-2 block min-w-0 text-[13px] font-semibold leading-5 text-text-primary">{todo.title}</span>
      </button>
      {!expanded && todo.body && <p className="line-clamp-2 px-3 pb-2 text-[12px] leading-5 text-text-tertiary">{todo.body}</p>}
      {!expanded && todo.rejectionReason && <p className="line-clamp-2 px-3 pb-2 text-[12px] leading-5 text-error">Rejected: {todo.rejectionReason}</p>}
      {!expanded && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3">
          <CollapsedTodoAssociations
            todo={todo}
            slug={slug}
            linkedSession={linkedSession}
            linkedAutomation={linkedAutomation}
            associationSessionActivity={associationSessionActivity}
            associationPresentation={associationPresentation}
            sessionsLoading={sessionsLoading}
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
        <div className="space-y-3 border-t border-border-subtle bg-bg-elevated px-3 py-3">
          {editing ? (
            <div className="space-y-2">
              <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Todo title" className="h-8 w-full rounded-sm border border-border-control bg-bg-base px-3 text-[12px] text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-muted" />
              <textarea value={body} onChange={(event) => setBody(event.target.value)} aria-label="Todo body" rows={4} className="w-full resize-y rounded-sm border border-border-control bg-bg-base px-3 py-2 text-[12px] leading-5 text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-muted" />
              <div className="flex gap-2"><TodoActionButton onClick={save} variant="primary"><Save size={12} /> Save</TodoActionButton><TodoActionButton onClick={() => setEditing(false)}><X size={12} /> Cancel</TodoActionButton></div>
            </div>
          ) : (
            <>{todo.body && <p className="whitespace-pre-wrap text-[12px] leading-5 text-text-secondary">{todo.body}</p>}{todo.rejectionReason && <div className="rounded-md border border-error/30 bg-error-muted px-3 py-2 text-[12px] leading-5 text-error"><span className="font-semibold">Rejected:</span> {todo.rejectionReason}</div>}<div className="flex flex-wrap gap-2"><TodoActionButton onClick={beginEditing}>Edit</TodoActionButton>{!isArchived && todo.status !== "done" && <TodoActionButton onClick={startDiscussion} disabled={discuss.isPending} variant="brand"><MessageCircle size={12} /> {todo.discussionSessionId ? "Continue Discussion" : "Discuss"}</TodoActionButton>}</div></>
          )}

          {todo.activation && (
            <div className="border border-border-subtle bg-bg-base px-3 py-3 text-[11px] text-text-tertiary">
              <div className="mb-2 flex items-center gap-2 font-semibold text-text-secondary"><TodoAssociationGlyph presentation={associationPresentation} label="Activation" /> Activation · {todo.activation.kind}</div>
              <div className="flex flex-wrap items-center gap-2">
                {todo.activation.resourceId === undefined ? (
                  <><Link className="inline-flex items-center gap-1 text-brand hover:underline" to={`/projects/${slug}/sessions/${todo.activation.sourceSessionId}`}>Source Session <ExternalLink size={10} /></Link><span>Preparing resource…</span></>
                ) : todo.activation.kind === "session" ? (
                  linkedSession ? <Link className="inline-flex items-center gap-1 text-brand hover:underline" to={`/projects/${slug}/sessions/${linkedSession.sessionId}`}>Session · {runtimeInitialized ? associationSessionActivity ?? "idle" : "loading"}<ExternalLink size={10} /></Link> : <span>{sessionsLoading ? "Loading resource…" : "Deleted"}</span>
                ) : linkedAutomation ? (
                  <Link className="inline-flex items-center gap-1 text-brand hover:underline" to={`/projects/${slug}/automations/${linkedAutomation.id}`}>Automation · {linkedAutomation.status}<ExternalLink size={10} /></Link>
                ) : <span>{automationsLoading ? "Loading resource…" : "Deleted"}</span>}
              </div>
            </div>
          )}

          {!isArchived && todo.status === "idea" && (
            <div className="flex flex-wrap gap-2">
              <TodoActionButton onClick={() => setStatus("ready")} variant="info"><Check size={12} /> Mark Ready</TodoActionButton>
              <RejectButton onClick={beginRejecting} />
            </div>
          )}
          {!isArchived && todo.status === "rejected" && (
            <div className="flex flex-wrap gap-2"><TodoActionButton onClick={() => setStatus("idea")}><RotateCcw size={12} /> Restore to Idea</TodoActionButton></div>
          )}
          {!isArchived && todo.status === "ready" && !todo.activation && (
            <div className="flex flex-wrap gap-2">
              <TodoActionButton onClick={() => startActivation("session")} disabled={activate.isPending} variant="primary"><Send size={12} /> Start Session</TodoActionButton>
              <TodoActionButton onClick={() => startActivation("automation")} disabled={activate.isPending}>Create Automation</TodoActionButton>
              <TodoActionButton onClick={() => setStatus("idea")}><RotateCcw size={12} /> Move to Idea</TodoActionButton>
              <RejectButton onClick={beginRejecting} />
              <TodoActionButton onClick={() => setStatus("done")} variant="success"><Check size={12} /> Mark Done</TodoActionButton>
            </div>
          )}
          {!isArchived && inProgress && (
            <div className="flex flex-wrap gap-2">
              <TodoActionButton onClick={runReturn} disabled={returnToReady.isPending} variant="warning">Return to Ready</TodoActionButton>
              <TodoActionButton onClick={() => setStatus("done")} variant="success"><Check size={12} /> Mark Done</TodoActionButton>
            </div>
          )}
          {!isArchived && todo.status === "done" && <TodoActionButton onClick={() => setStatus("ready")} variant="info"><RotateCcw size={12} /> Reopen</TodoActionButton>}
          {!isArchived && !inProgress && <TodoActionButton onClick={runArchive} variant="quiet"><Archive size={12} /> Archive</TodoActionButton>}
          {isArchived && <TodoActionButton onClick={runRestore}><RotateCcw size={12} /> Restore</TodoActionButton>}
          {!isArchived && (todo.status === "idea" || (todo.status === "ready" && !todo.activation)) && rejecting && (
            <div className="rounded-md border border-error/30 bg-error-muted p-3">
              <textarea autoFocus aria-label="Rejection reason" aria-describedby={rejectionError ? `todo-${todo.id}-rejection-error` : undefined} value={rejectReason} onChange={(event) => { setRejectReason(event.target.value); setRejectionError(null); }} placeholder="Why should this Todo be rejected?" rows={2} className="w-full resize-none bg-transparent text-[11px] leading-4 text-text-primary outline-none placeholder:text-text-muted" />
              {rejectionError && <p id={`todo-${todo.id}-rejection-error`} role="alert" className="mt-1 text-[11px] text-error">{rejectionError}</p>}
              <div className="mt-2 flex justify-end gap-2"><TodoActionButton onClick={() => { setRejecting(false); setRejectionError(null); }} variant="quiet">Cancel</TodoActionButton><TodoActionButton onClick={submitRejection} variant="danger">Reject Todo</TodoActionButton></div>
            </div>
          )}
        </div>
      )}
      {actionError && <p role="alert" className="border-t border-error/20 bg-error-muted px-3 py-2 text-[11px] text-error">{actionError}</p>}
    </article>
  );
}

function CompactPrimaryAction({ label, onClick, disabled = false }: { label: string; onClick: () => void; disabled?: boolean }) {
  return <TodoActionButton onClick={onClick} disabled={disabled} variant="brand">{label}</TodoActionButton>;
}

function TodoVisualGlyph({
  Icon,
  tone,
  label,
  size = 14,
  motion = "none",
}: {
  Icon: ProjectTodoGlyph;
  tone: StatusTone;
  label: string;
  size?: number;
  motion?: "none" | "loop";
}) {
  if (Icon === "activity-arc") return <ActivityArc size={size} tone={tone} label={label} />;
  return <Icon className={`${STATUS_TONE_CLASS[tone]} ${motion === "loop" ? "animate-activity" : ""}`} size={size} strokeWidth={1.75} aria-label={label} />;
}

function TodoAssociationGlyph({ presentation, label }: { presentation?: ProjectTodoAssociationPresentation; label: string }) {
  if (presentation === undefined) return null;
  return <TodoVisualGlyph Icon={presentation.Icon} tone={presentation.tone} motion={presentation.motion} size={12} label={label} />;
}

function CollapsedTodoAssociations({ todo, slug, linkedSession, linkedAutomation, associationSessionActivity, associationPresentation, sessionsLoading, automationsLoading, runtimeInitialized }: {
  todo: ProjectTodo;
  slug: string;
  linkedSession?: import("../api/types").SessionSummary;
  linkedAutomation?: import("../api/types").Automation;
  associationSessionActivity?: import("@archcode/protocol").SessionFamilyActivity;
  associationPresentation?: ProjectTodoAssociationPresentation;
  sessionsLoading: boolean;
  automationsLoading: boolean;
  runtimeInitialized: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] leading-4 text-text-tertiary" aria-label="Todo associations">
      {todo.discussionSessionId && <Link className="inline-flex items-center gap-1 text-brand hover:underline" to={`/projects/${slug}/sessions/${todo.discussionSessionId}`}><TodoVisualGlyph Icon={PROJECT_TODO_DISCUSSION_PRESENTATION.Icon} tone={PROJECT_TODO_DISCUSSION_PRESENTATION.tone} label="Discussion" size={12} /> Discussion</Link>}
      {todo.activation && (
        todo.activation.resourceId === undefined ? (
          <Link className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary" to={`/projects/${slug}/sessions/${todo.activation.sourceSessionId}`}><TodoAssociationGlyph presentation={associationPresentation} label="Activation preparing" /> Activation · {todo.activation.kind} · preparing</Link>
        ) : todo.activation.kind === "session" ? (
          linkedSession ? <Link className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary" to={`/projects/${slug}/sessions/${linkedSession.sessionId}`}><TodoAssociationGlyph presentation={associationPresentation} label="Activation session" /> Activation · Session · {runtimeInitialized ? associationSessionActivity ?? "idle" : "loading"}</Link> : <span className="inline-flex items-center gap-1"><TodoAssociationGlyph presentation={associationPresentation} label="Activation session" /> Activation · Session · {sessionsLoading ? "loading" : "deleted"}</span>
        ) : linkedAutomation ? (
          <Link className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary" to={`/projects/${slug}/automations/${linkedAutomation.id}`}><TodoAssociationGlyph presentation={associationPresentation} label="Activation automation" /> Activation · Automation · {linkedAutomation.status}</Link>
        ) : <span className="inline-flex items-center gap-1"><TodoAssociationGlyph presentation={associationPresentation} label="Activation automation" /> Activation · Automation · {automationsLoading ? "loading" : "deleted"}</span>
      )}
      {!todo.discussionSessionId && !todo.activation && <span className="py-1 text-text-tertiary">No linked work yet</span>}
    </div>
  );
}

function ViewButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`rounded-sm px-3 py-2 text-[12px] font-medium transition-colors ${active ? "bg-bg-active text-text-primary" : "text-text-tertiary hover:bg-bg-hover hover:text-text-primary"}`}>{label}</button>;
}

function RejectButton({ onClick }: { onClick: () => void }) {
  return <TodoActionButton onClick={onClick} variant="dangerQuiet"><Trash2 size={12} /> Reject</TodoActionButton>;
}

type TodoActionVariant = "primary" | "brand" | "info" | "success" | "warning" | "danger" | "dangerQuiet" | "secondary" | "quiet";

const TODO_ACTION_STYLES: Record<TodoActionVariant, string> = {
  primary: "border-brand bg-brand text-bg-base hover:bg-brand-hover",
  brand: "border-brand/30 bg-brand-subtle text-brand hover:bg-brand-muted",
  info: "border-info/30 bg-info-muted text-info hover:border-info/50",
  success: "border-success/30 bg-success-muted text-success hover:border-success/50",
  warning: "border-warning/30 bg-warning-muted text-warning hover:border-warning/50",
  danger: "border-error bg-error text-bg-overlay hover:brightness-110",
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
      className={`inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-sm border px-3 text-[12px] font-medium transition-[background-color,border-color,color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50 ${TODO_ACTION_STYLES[variant]}`}
    >
      {children}
    </button>
  );
}
