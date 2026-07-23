import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Archive,
  Ban,
  Check,
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
import type {
  Automation,
  ProjectTodo,
  ProjectTodoActivationKind,
  ProjectTodoUpdateInput,
  SessionSummary,
} from "../api/types";
import {
  runtimeFamilyKey,
  useSessionRuntimeFamilies,
  useSessionRuntimeInitialized,
} from "../store/session-runtime-store";
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
type RuntimeFamilies = ReturnType<typeof useSessionRuntimeFamilies>;

interface TodoResourceProps {
  slug: string;
  sessions?: SessionSummary[];
  automations?: Automation[];
  runtimeFamilies: RuntimeFamilies;
  sessionsLoading: boolean;
  automationsLoading: boolean;
  runtimeInitialized: boolean;
}

export function ProjectTodosRoute() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: todos, isLoading, error } = useProjectTodos(slug);
  const { data: sessions, isLoading: sessionsLoading } = useSessions(slug);
  const { data: automations, isLoading: automationsLoading } = useAutomations(slug);
  const runtimeFamilies = useSessionRuntimeFamilies();
  const runtimeInitialized = useSessionRuntimeInitialized(slug);
  const [view, setView] = useState<View>("board");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const createTodo = useCreateProjectTodo();
  const selectedTodoId = searchParams.get("todo");
  const appliedSelectionRef = useRef<string | null>(null);

  const resourceProps: TodoResourceProps = {
    slug,
    sessions,
    automations,
    runtimeFamilies,
    sessionsLoading,
    automationsLoading,
    runtimeInitialized,
  };

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
    setSelectedId(selectedTodo.id);
    appliedSelectionRef.current = selectedTodoId;
  }, [selectedTodoId, todos]);

  const visibleTodos = useMemo(() => {
    const list = todos ?? [];
    if (view === "archived") return list.filter((todo) => todo.archivedAt !== undefined);
    if (view === "rejected") {
      return list.filter((todo) => todo.archivedAt === undefined && todo.status === "rejected");
    }
    return list.filter((todo) => todo.archivedAt === undefined && todo.status !== "rejected");
  }, [todos, view]);

  const groups = useMemo(() => deriveProjectTodoGroups(visibleTodos), [visibleTodos]);
  const selectedTodo = todos?.find((todo) => todo.id === selectedId);

  const updateSelectionQuery = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("todo", id);
    else next.delete("todo");
    setSearchParams(next, { replace: true });
  };

  const selectTodo = (id: string) => {
    setSelectedId(id);
    updateSelectionQuery(id);
  };

  const closeTodo = () => {
    setSelectedId(null);
    updateSelectionQuery(null);
  };

  const selectView = (nextView: View) => {
    setView(nextView);
    setSelectedId(null);
    updateSelectionQuery(null);
  };

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
        selectTodo(result.todo.id);
      },
      onError: (cause) => setCreateError(cause instanceof Error ? cause.message : "Failed to create Todo"),
    });
  };

  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-text-tertiary">Loading Todos…</div>;
  }
  if (error) {
    return <div className="flex h-full items-center justify-center text-sm text-error">Failed to load Todos</div>;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg-base">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-4 border-b border-border-default bg-bg-surface px-4 py-3 min-[621px]:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-1 h-5 w-2 shrink-0 bg-brand" aria-hidden="true" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Lightbulb size={16} className="text-brand" aria-hidden="true" />
              <h1 className="text-[18px] font-semibold leading-6 text-text-primary">Todos</h1>
              {(todos?.length ?? 0) > 0 && (
                <span className="text-[11px] font-medium tabular-nums text-text-tertiary">
                  {todos?.length} total
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[12px] leading-5 text-text-tertiary">
              Capture intent, discuss it with Lead, then hand it to execution.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-5 border-b border-border-subtle" role="group" aria-label="Todo views">
          <ViewButton active={view === "board"} onClick={() => selectView("board")} label="Board" />
          <ViewButton active={view === "rejected"} onClick={() => selectView("rejected")} label="Rejected" />
          <ViewButton active={view === "archived"} onClick={() => selectView("archived")} label="Archived" />
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-4 pt-4 min-[621px]:px-5">
          <div className="mx-auto flex max-w-[1500px] flex-col gap-2 rounded-lg border border-border-control bg-bg-elevated p-2 transition-[border-color,box-shadow] focus-within:border-brand focus-within:ring-2 focus-within:ring-brand-subtle min-[621px]:flex-row min-[621px]:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Plus size={15} className="shrink-0 text-text-tertiary" aria-hidden="true" />
              <input
                aria-label="New Todo title"
                value={newTitle}
                onChange={(event) => {
                  setNewTitle(event.target.value);
                  setCreateError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleCreate();
                }}
                placeholder="What do you want to remember or explore later?"
                className="min-w-0 flex-1 bg-transparent px-2 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none"
              />
            </div>
            <button
              type="button"
              aria-label="New Todo"
              onClick={handleCreate}
              disabled={createTodo.isPending}
              className="inline-flex h-8 w-full shrink-0 items-center justify-center gap-2 rounded-sm border border-brand bg-brand px-3 text-[12px] font-medium text-bg-base transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50 min-[621px]:w-auto"
            >
              <Plus size={13} aria-hidden="true" /> New Todo
            </button>
          </div>
          {createError && (
            <p role="alert" className="mx-auto mt-2 max-w-[1500px] px-1 text-xs text-error">{createError}</p>
          )}
        </div>

        <main className="min-h-0 flex-1 overflow-auto px-4 pb-6 pt-4 min-[621px]:px-5">
          {view === "board" ? (
            <div
              className="mx-auto grid max-w-[1500px] grid-cols-1 items-start gap-3 min-[621px]:grid-cols-2 min-[1181px]:grid-cols-4"
              data-testid="todo-board"
            >
              {(Object.keys(PROJECT_TODO_LANE_PRESENTATIONS) as ProjectTodoLane[]).map((lane) => (
                <TodoGroup
                  key={lane}
                  lane={lane}
                  todos={groups[lane]}
                  selectedId={selectedId}
                  onSelect={selectTodo}
                  {...resourceProps}
                />
              ))}
            </div>
          ) : (
            <TodoFlatList
              view={view}
              todos={visibleTodos}
              selectedId={selectedId}
              onSelect={selectTodo}
            />
          )}
        </main>

        <TodoDetailDrawer
          todo={selectedTodo}
          onClose={closeTodo}
          navigate={navigate}
          {...resourceProps}
        />
      </div>
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

function TodoGroup({
  lane,
  todos,
  selectedId,
  onSelect,
  ...resourceProps
}: TodoResourceProps & {
  lane: ProjectTodoLane;
  todos: ProjectTodo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const presentation = PROJECT_TODO_LANE_PRESENTATIONS[lane];
  const { Icon } = presentation;
  return (
    <section className="min-w-0" aria-label={presentation.title}>
      <div className="flex min-h-12 items-center justify-between gap-2 border-b border-border-subtle pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon size={14} className={STATUS_TONE_CLASS[presentation.tone]} aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-[12px] font-semibold leading-4 text-text-primary">{presentation.title}</h2>
            <p className="truncate text-[11px] leading-4 text-text-tertiary">{presentation.hint}</p>
          </div>
        </div>
        <span className="shrink-0 text-[10px] font-semibold tabular-nums text-text-tertiary">{todos.length}</span>
      </div>
      <div className="flex flex-col gap-2 pt-2">
        {todos.length === 0 ? (
          <div className="flex min-h-24 flex-col items-center justify-center px-3 text-center">
            <Icon size={16} className={`mb-1 ${STATUS_TONE_CLASS[presentation.tone]}`} aria-hidden="true" />
            <p className="text-[11px] font-medium leading-4 text-text-tertiary">{presentation.emptyTitle}</p>
            <p className="mt-1 text-[11px] leading-4 text-text-tertiary">{presentation.emptyHint}</p>
          </div>
        ) : todos.map((todo) => (
          <TodoBoardCard
            key={todo.id}
            todo={todo}
            selected={selectedId === todo.id}
            onSelect={() => onSelect(todo.id)}
            {...resourceProps}
          />
        ))}
      </div>
    </section>
  );
}

function TodoBoardCard({
  todo,
  selected,
  onSelect,
  ...resourceProps
}: TodoResourceProps & {
  todo: ProjectTodo;
  selected: boolean;
  onSelect: () => void;
}) {
  const resources = resolveTodoResources(todo, resourceProps);
  const presentation = presentProjectTodoCard({
    status: todo.status,
    ...(todo.archivedAt === undefined ? {} : { archivedAt: todo.archivedAt }),
    hasActivation: todo.activation !== undefined,
  });

  return (
    <article
      className={`relative min-h-32 overflow-hidden rounded-md border bg-bg-surface transition-[border-color,box-shadow] ${
        selected
          ? "border-brand before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-brand"
          : "border-border-default hover:border-border-strong"
      }`}
      data-testid={`todo-${todo.id}`}
    >
      <button
        type="button"
        data-testid={`todo-open-${todo.id}`}
        className="block w-full px-3 pb-2 pt-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/50"
        onClick={onSelect}
        aria-expanded={selected}
        aria-haspopup="dialog"
      >
        <span className="inline-flex items-center gap-2 text-[11px] font-semibold leading-4 text-text-secondary">
          <TodoVisualGlyph Icon={presentation.Icon} tone={presentation.tone} label={presentation.label} />
          {presentation.label}
        </span>
        <span className="mt-2 block text-[13px] font-semibold leading-5 text-text-primary">{todo.title}</span>
        {todo.body && (
          <span className="mt-1 line-clamp-2 text-[12px] leading-5 text-text-tertiary">{todo.body}</span>
        )}
      </button>
      <div className="px-3 pb-2">
        <TodoAssociations todo={todo} {...resources} {...resourceProps} />
      </div>
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-center justify-between border-t border-border-subtle px-3 py-2 text-left text-[11px] font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary"
      >
        <span>{todoNextAction(todo)}</span>
        <span aria-hidden="true">→</span>
      </button>
    </article>
  );
}

function TodoFlatList({
  view,
  todos,
  selectedId,
  onSelect,
}: {
  view: Exclude<View, "board">;
  todos: ProjectTodo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const rejected = view === "rejected";
  return (
    <section className="mx-auto max-w-[980px]" aria-label={rejected ? "Rejected Todos" : "Archived Todos"}>
      <header className="flex items-start gap-3 border-b border-border-default pb-3">
        {rejected
          ? <Ban size={16} className="mt-0.5 text-warning" aria-hidden="true" />
          : <Archive size={16} className="mt-0.5 text-text-tertiary" aria-hidden="true" />}
        <div>
          <h2 className="text-[14px] font-semibold text-text-primary">
            {rejected ? "Rejected Todos" : "Archived Todos"}
          </h2>
          <p className="mt-0.5 text-[11px] leading-4 text-text-tertiary">
            {rejected
              ? "Ideas intentionally declined, with their reasoning preserved."
              : "Inactive items kept out of the active workflow."}
          </p>
        </div>
      </header>
      {todos.length === 0 ? (
        <div className="flex min-h-28 flex-col items-center justify-center border-b border-border-subtle px-6 text-center">
          <p className="text-[12px] font-medium text-text-secondary">Nothing here yet</p>
          <p className="mt-1 text-[11px] text-text-tertiary">Items moved here stay recoverable.</p>
        </div>
      ) : (
        <div className="divide-y divide-border-subtle border-b border-border-subtle" data-testid={`todo-${view}-list`}>
          {todos.map((todo) => {
            const origin = presentProjectTodoCard({
              status: todo.status,
              hasActivation: todo.activation !== undefined,
            });
            return (
              <article
                key={todo.id}
                data-testid={`todo-${todo.id}`}
                className={selectedId === todo.id ? "relative bg-brand-subtle before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-brand" : ""}
              >
                <button
                  type="button"
                  data-testid={`todo-open-${todo.id}`}
                  onClick={() => onSelect(todo.id)}
                  aria-expanded={selectedId === todo.id}
                  aria-haspopup="dialog"
                  className="grid min-h-18 w-full gap-2 px-3 py-3 text-left hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/50 min-[621px]:grid-cols-[minmax(0,1fr)_auto] min-[621px]:items-center"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <TodoVisualGlyph
                        Icon={rejected ? Ban : Archive}
                        tone={rejected ? "warning" : "neutral"}
                        label={rejected ? "Rejected" : "Archived"}
                        size={13}
                      />
                      <span className="truncate text-[13px] font-semibold text-text-primary">{todo.title}</span>
                    </span>
                    <span className={`mt-1 line-clamp-2 text-[11px] leading-4 ${rejected ? "text-warning" : "text-text-tertiary"}`}>
                      {rejected
                        ? todo.rejectionReason ?? "No rejection reason recorded."
                        : `From ${origin.label} · Archived ${formatTodoDate(todo.archivedAt)}`}
                    </span>
                  </span>
                  <span className="text-[11px] font-medium text-brand">{todoNextAction(todo)} →</span>
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TodoDetailDrawer({
  todo,
  onClose,
  navigate,
  ...resourceProps
}: TodoResourceProps & {
  todo?: ProjectTodo;
  onClose: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  if (!todo) return null;

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          forceMount
          className="fixed inset-0 z-[60] bg-black/45"
        />
        <DialogPrimitive.Content
          forceMount
          data-testid="todo-detail-drawer"
          className="fixed inset-y-0 right-0 z-[61] flex w-[min(430px,calc(100%-18px))] flex-col border-l border-border-strong bg-bg-elevated shadow-2xl focus:outline-none"
        >
          <TodoDetailPanel key={todo.id} todo={todo} navigate={navigate} {...resourceProps} />
          <DialogPrimitive.Close asChild>
            <button
              type="button"
              aria-label="Close Todo details"
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function TodoDetailPanel({
  todo,
  slug,
  navigate,
  ...resourceProps
}: TodoResourceProps & {
  todo: ProjectTodo;
  navigate: ReturnType<typeof useNavigate>;
}) {
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
  const resources = resolveTodoResources(todo, { slug, ...resourceProps });
  const presentation = presentProjectTodoCard({
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

  const mutate = (fn: () => void) => {
    setActionError(null);
    fn();
  };
  const showError = (cause: unknown) => {
    setActionError(cause instanceof Error ? cause.message : "Action failed");
  };
  const beginEditing = () => {
    setTitle(todo.title);
    setBody(todo.body);
    setBaseRevision(todo.revision);
    setEditing(true);
  };
  const save = () => {
    if (baseRevision === null) return;
    mutate(() => update.mutate({
      slug,
      todoId: todo.id,
      input: { expectedRevision: baseRevision, patch: { title: title.trim(), body } },
    }, {
      onSuccess: () => setEditing(false),
      onError: showError,
    }));
  };
  const setStatus = (
    status: "idea" | "ready" | "rejected" | "done",
    rejectionReason?: string,
  ) => mutate(() => update.mutate({
    slug,
    todoId: todo.id,
    input: {
      expectedRevision: todo.revision,
      patch: { status, ...(rejectionReason ? { rejectionReason } : {}) },
    } as ProjectTodoUpdateInput,
  }, { onError: showError }));
  const startDiscussion = () => mutate(() => discuss.mutate({
    slug,
    todoId: todo.id,
    expectedRevision: todo.revision,
  }, {
    onSuccess: (result) => navigate(`/projects/${slug}/sessions/${result.sessionId}`),
    onError: showError,
  }));
  const startActivation = (kind: ProjectTodoActivationKind) => {
    setActionError(null);
    void activate.mutateAsync({ slug, todoId: todo.id, kind, expectedRevision: todo.revision })
      .then((result) => navigate(`/projects/${slug}/sessions/${result.sessionId}`))
      .catch(showError);
  };
  const runArchive = () => mutate(() => archive.mutate({
    slug,
    todoId: todo.id,
    expectedRevision: todo.revision,
  }, { onError: showError }));
  const runRestore = () => mutate(() => restore.mutate({
    slug,
    todoId: todo.id,
    expectedRevision: todo.revision,
  }, { onError: showError }));
  const runReturn = () => mutate(() => returnToReady.mutate({
    slug,
    todoId: todo.id,
    expectedRevision: todo.revision,
  }, { onError: showError }));
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
    <>
      <header className="shrink-0 border-b border-border-default px-5 pb-4 pr-14 pt-4">
        <span className="inline-flex items-center gap-2 text-[11px] font-semibold text-text-secondary">
          <TodoVisualGlyph Icon={presentation.Icon} tone={presentation.tone} label={presentation.label} />
          {presentation.label}
        </span>
        <DialogPrimitive.Title className="mt-2 text-[18px] font-semibold leading-6 text-text-primary">
          {todo.title}
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="mt-1 text-[11px] leading-4 text-text-tertiary">
          Review linked work and choose the next lifecycle action.
        </DialogPrimitive.Description>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="space-y-5">
          <section aria-label="Todo content">
            {editing ? (
              <div className="space-y-2">
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  aria-label="Todo title"
                  className="h-8 w-full rounded-sm border border-border-control bg-bg-base px-3 text-[12px] text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-subtle"
                />
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  aria-label="Todo body"
                  rows={4}
                  className="w-full resize-y rounded-sm border border-border-control bg-bg-base px-3 py-2 text-[12px] leading-5 text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-subtle"
                />
                <div className="flex gap-2">
                  <TodoActionButton onClick={save} variant="primary"><Save size={12} /> Save</TodoActionButton>
                  <TodoActionButton onClick={() => setEditing(false)}><X size={12} /> Cancel</TodoActionButton>
                </div>
              </div>
            ) : (
              <>
                {todo.body
                  ? <p className="whitespace-pre-wrap text-[12px] leading-5 text-text-secondary">{todo.body}</p>
                  : <p className="text-[12px] leading-5 text-text-tertiary">No additional details.</p>}
                {todo.rejectionReason && (
                  <div className="mt-3 border-y border-warning/30 bg-warning-muted px-3 py-2 text-[12px] leading-5 text-warning">
                    <span className="font-semibold">Rejected:</span> {todo.rejectionReason}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <TodoActionButton onClick={beginEditing}>Edit</TodoActionButton>
                  {!isArchived && todo.status !== "done" && (
                    <TodoActionButton
                      onClick={startDiscussion}
                      disabled={discuss.isPending}
                      variant="brand"
                    >
                      <MessageCircle size={12} />
                      {todo.discussionSessionId ? "Continue Discussion" : "Discuss"}
                    </TodoActionButton>
                  )}
                </div>
              </>
            )}
          </section>

          <section aria-label="Linked work" className="border-t border-border-subtle pt-4">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
              Linked work
            </h3>
            <TodoAssociations todo={todo} {...resources} slug={slug} {...resourceProps} />
          </section>

          <section aria-label="Todo actions" className="border-t border-border-subtle pt-4">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
              Next action
            </h3>
            <div className="flex flex-wrap gap-2">
              {!isArchived && todo.status === "idea" && (
                <>
                  <TodoActionButton onClick={() => setStatus("ready")} variant="info">
                    <Check size={12} /> Mark Ready
                  </TodoActionButton>
                  <RejectButton onClick={beginRejecting} />
                </>
              )}
              {!isArchived && todo.status === "rejected" && (
                <TodoActionButton onClick={() => setStatus("idea")}>
                  <RotateCcw size={12} /> Restore to Idea
                </TodoActionButton>
              )}
              {!isArchived && todo.status === "ready" && !todo.activation && (
                <>
                  <TodoActionButton
                    onClick={() => startActivation("session")}
                    disabled={activate.isPending}
                    variant="primary"
                  >
                    <Send size={12} /> Start Session
                  </TodoActionButton>
                  <TodoActionButton
                    onClick={() => startActivation("automation")}
                    disabled={activate.isPending}
                  >
                    Create Automation
                  </TodoActionButton>
                  <TodoActionButton onClick={() => setStatus("idea")}>
                    <RotateCcw size={12} /> Move to Idea
                  </TodoActionButton>
                  <RejectButton onClick={beginRejecting} />
                  <TodoActionButton onClick={() => setStatus("done")} variant="success">
                    <Check size={12} /> Mark Done
                  </TodoActionButton>
                </>
              )}
              {!isArchived && inProgress && (
                <>
                  <TodoActionButton onClick={runReturn} disabled={returnToReady.isPending} variant="warning">
                    Return to Ready
                  </TodoActionButton>
                  <TodoActionButton onClick={() => setStatus("done")} variant="success">
                    <Check size={12} /> Mark Done
                  </TodoActionButton>
                </>
              )}
              {!isArchived && todo.status === "done" && (
                <TodoActionButton onClick={() => setStatus("ready")} variant="info">
                  <RotateCcw size={12} /> Reopen
                </TodoActionButton>
              )}
              {!isArchived && !inProgress && (
                <TodoActionButton onClick={runArchive} variant="quiet">
                  <Archive size={12} /> Archive
                </TodoActionButton>
              )}
              {isArchived && (
                <TodoActionButton onClick={runRestore}>
                  <RotateCcw size={12} /> Restore
                </TodoActionButton>
              )}
            </div>
          </section>

          {!isArchived
            && (todo.status === "idea" || (todo.status === "ready" && !todo.activation))
            && rejecting && (
              <div className="border-y border-warning/30 bg-warning-muted p-3">
                <textarea
                  autoFocus
                  aria-label="Rejection reason"
                  aria-describedby={rejectionError ? `todo-${todo.id}-rejection-error` : undefined}
                  value={rejectReason}
                  onChange={(event) => {
                    setRejectReason(event.target.value);
                    setRejectionError(null);
                  }}
                  placeholder="Why should this Todo be rejected?"
                  rows={2}
                  className="w-full resize-none bg-transparent text-[11px] leading-4 text-text-primary outline-none placeholder:text-text-muted"
                />
                {rejectionError && (
                  <p id={`todo-${todo.id}-rejection-error`} role="alert" className="mt-1 text-[11px] text-error">
                    {rejectionError}
                  </p>
                )}
                <div className="mt-2 flex justify-end gap-2">
                  <TodoActionButton
                    onClick={() => {
                      setRejecting(false);
                      setRejectionError(null);
                    }}
                    variant="quiet"
                  >
                    Cancel
                  </TodoActionButton>
                  <TodoActionButton onClick={submitRejection} variant="danger">Reject Todo</TodoActionButton>
                </div>
              </div>
            )}
        </div>
      </div>
      {actionError && (
        <p role="alert" className="shrink-0 border-t border-error/20 bg-error-muted px-5 py-3 text-[11px] text-error">
          {actionError}
        </p>
      )}
    </>
  );
}

function resolveTodoResources(todo: ProjectTodo, props: TodoResourceProps) {
  const linkedSession = todo.activation?.kind === "session" && todo.activation.resourceId
    ? props.sessions?.find((session) => session.sessionId === todo.activation?.resourceId)
    : undefined;
  const linkedAutomation = todo.activation?.kind === "automation" && todo.activation.resourceId
    ? props.automations?.find((automation) => automation.id === todo.activation?.resourceId)
    : undefined;
  const associationSessionId = todo.activation?.resourceId === undefined
    ? todo.activation?.sourceSessionId
    : linkedSession?.sessionId;
  const associationSessionActivity = associationSessionId && props.runtimeInitialized
    ? props.runtimeFamilies[runtimeFamilyKey(props.slug, associationSessionId)]?.activity ?? "idle"
    : undefined;
  const associationPresentation = todo.activation === undefined ? undefined : presentProjectTodoAssociation({
    resourceLoading: todo.activation.kind === "session" ? props.sessionsLoading : props.automationsLoading,
    runtimeInitialized: props.runtimeInitialized,
    sessionActivity: associationSessionActivity,
    resourceId: todo.activation.resourceId,
    resourceAvailable: todo.activation.kind === "session"
      ? linkedSession !== undefined
      : linkedAutomation !== undefined,
    ...(linkedAutomation ? { automationStatus: linkedAutomation.status } : {}),
  });

  return {
    linkedSession,
    linkedAutomation,
    associationSessionActivity,
    associationPresentation,
  };
}

function TodoAssociations({
  todo,
  slug,
  linkedSession,
  linkedAutomation,
  associationSessionActivity,
  associationPresentation,
  sessionsLoading,
  automationsLoading,
  runtimeInitialized,
}: {
  todo: ProjectTodo;
  slug: string;
  linkedSession?: SessionSummary;
  linkedAutomation?: Automation;
  associationSessionActivity?: import("@archcode/protocol").SessionFamilyActivity;
  associationPresentation?: ProjectTodoAssociationPresentation;
  sessionsLoading: boolean;
  automationsLoading: boolean;
  runtimeInitialized: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] leading-4 text-text-tertiary" aria-label="Todo associations">
      {todo.discussionSessionId && (
        <Link
          className="inline-flex items-center gap-1 text-brand hover:underline"
          to={`/projects/${slug}/sessions/${todo.discussionSessionId}`}
        >
          <TodoVisualGlyph
            Icon={PROJECT_TODO_DISCUSSION_PRESENTATION.Icon}
            tone={PROJECT_TODO_DISCUSSION_PRESENTATION.tone}
            label="Discussion"
            size={12}
          />
          Discussion
        </Link>
      )}
      {todo.activation && (
        todo.activation.resourceId === undefined ? (
          <Link
            className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary"
            to={`/projects/${slug}/sessions/${todo.activation.sourceSessionId}`}
          >
            <TodoAssociationGlyph presentation={associationPresentation} label="Activation preparing" />
            Activation · {todo.activation.kind} · preparing
          </Link>
        ) : todo.activation.kind === "session" ? (
          linkedSession ? (
            <Link
              className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary"
              to={`/projects/${slug}/sessions/${linkedSession.sessionId}`}
            >
              <TodoAssociationGlyph presentation={associationPresentation} label="Activation session" />
              Activation · Session · {runtimeInitialized ? associationSessionActivity ?? "idle" : "loading"}
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1">
              <TodoAssociationGlyph presentation={associationPresentation} label="Activation session" />
              Activation · Session · {sessionsLoading ? "loading" : "deleted"}
            </span>
          )
        ) : linkedAutomation ? (
          <Link
            className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary"
            to={`/projects/${slug}/automations/${linkedAutomation.id}`}
          >
            <TodoAssociationGlyph presentation={associationPresentation} label="Activation automation" />
            Activation · Automation · {linkedAutomation.status}
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1">
            <TodoAssociationGlyph presentation={associationPresentation} label="Activation automation" />
            Activation · Automation · {automationsLoading ? "loading" : "deleted"}
          </span>
        )
      )}
      {!todo.discussionSessionId && !todo.activation && (
        <span className="py-1 text-text-tertiary">No linked work yet</span>
      )}
    </div>
  );
}

function todoNextAction(todo: ProjectTodo): string {
  if (todo.archivedAt !== undefined) return "Restore";
  if (todo.status === "rejected") return "Restore to Idea";
  if (todo.status === "idea") return todo.discussionSessionId ? "Continue Discussion" : "Discuss";
  if (todo.status === "done") return "Reopen";
  if (todo.activation?.resourceId === undefined && todo.activation) return "Preparing work";
  if (todo.activation?.kind === "session") return "Open Session";
  if (todo.activation?.kind === "automation") return "Open Automation";
  return "Start Session";
}

function formatTodoDate(timestamp?: number): string {
  if (timestamp === undefined) return "unknown";
  return new Date(timestamp).toLocaleDateString();
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
  return (
    <Icon
      className={`${STATUS_TONE_CLASS[tone]} ${motion === "loop" ? "animate-activity" : ""}`}
      size={size}
      strokeWidth={1.75}
      aria-label={label}
    />
  );
}

function TodoAssociationGlyph({
  presentation,
  label,
}: {
  presentation?: ProjectTodoAssociationPresentation;
  label: string;
}) {
  if (presentation === undefined) return null;
  return (
    <TodoVisualGlyph
      Icon={presentation.Icon}
      tone={presentation.tone}
      motion={presentation.motion}
      size={12}
      label={label}
    />
  );
}

function ViewButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`relative -mb-px px-0.5 py-2 text-[12px] font-medium transition-colors after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 ${
        active
          ? "text-text-primary after:bg-brand"
          : "text-text-tertiary after:bg-transparent hover:text-text-primary"
      }`}
    >
      {label}
    </button>
  );
}

function RejectButton({ onClick }: { onClick: () => void }) {
  return (
    <TodoActionButton onClick={onClick} variant="dangerQuiet">
      <Trash2 size={12} /> Reject
    </TodoActionButton>
  );
}

type TodoActionVariant =
  | "primary"
  | "brand"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "dangerQuiet"
  | "secondary"
  | "quiet";

const TODO_ACTION_STYLES: Record<TodoActionVariant, string> = {
  primary: "border-brand bg-brand text-bg-base hover:bg-brand-hover",
  brand: "border-brand/30 bg-brand-subtle text-brand hover:bg-bg-hover",
  info: "border-brand/30 bg-brand-subtle text-brand hover:border-brand/50",
  success: "border-success/30 bg-success-muted text-success hover:border-success/50",
  warning: "border-warning/30 bg-warning-muted text-warning hover:border-warning/50",
  danger: "border-error bg-error text-bg-overlay hover:brightness-110",
  dangerQuiet: "border-error/30 bg-transparent text-error hover:bg-error-muted",
  secondary: "border-border-default bg-bg-elevated text-text-secondary hover:border-border-strong hover:bg-bg-hover hover:text-text-primary",
  quiet: "border-transparent bg-transparent text-text-tertiary hover:bg-bg-hover hover:text-text-secondary",
};

function TodoActionButton({
  children,
  onClick,
  disabled = false,
  variant = "secondary",
}: {
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
