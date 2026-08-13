import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Columns3, GripVertical, LayoutList, Plus, Search, X } from "lucide-react";
import { ApiError } from "../api/client";
import { useCreateProjectTodo, useCreateProjectTodoSession, useRunProjectTodoNow, useStartProjectTodoDiscussion, useUpdateProjectTodo } from "../api/mutations";
import { useAutomationInventory, useProjectTodos, useSessionInventory } from "../api/queries";
import type { ProjectTodo, SessionSummary } from "../api/types";
import { createClientUuid } from "../lib/client-uuid";
import { STATUS_TONE_CLASS, type StatusTone } from "../lib/status-visuals";
import { PrimaryActionButton } from "../components/primitives/PrimaryActionButton";
import { RelativeTime } from "../components/primitives/TemporalText";
import { useAttentionVisibleScopedHitl, useHitlProjectInitialized } from "../store/hitl-store";
import { runtimeFamilyKey, useSessionRuntimeFamilies, useSessionRuntimeInitialized } from "../store/session-runtime-store";
import {
  deriveProjectTodoOperationalState,
  presentProjectTodoCard,
  projectTodoDisplayLead,
  projectTodoPreviewExcerpt,
  PROJECT_TODO_LANE_PRESENTATIONS,
  type ProjectTodoAttentionLabel,
  type ProjectTodoLane,
  type ProjectTodoOperationalState,
  type ProjectTodoStatus,
} from "./project-todo-presentation";

type TodoSurface = "active" | "rejected" | "archived";
type ActiveLayout = "list" | "board";
type BoardOrder = Record<ProjectTodoLane, string[]>;
const LANES: readonly ProjectTodoLane[] = ["idea", "ready", "in_progress", "done"];

interface ProjectTodoRunNowRecovery {
  readonly todoId: string;
  readonly sessionId?: string;
  readonly message: string;
  readonly content?: string;
}

interface ProjectTodoDiscussionStartRecovery {
  readonly todoId: string;
  readonly sessionId: string;
  readonly content: string;
  readonly message: string;
}

export function projectTodoRunNowRecovery(cause: unknown): ProjectTodoRunNowRecovery | null {
  if (!(cause instanceof ApiError) || cause.details === null || typeof cause.details !== "object") return null;
  const details = cause.details as Record<string, unknown>;
  if (details.scopeCode !== "PROJECT_TODO_RUN_NOW_RECOVERY_REQUIRED" || typeof details.todoId !== "string") return null;
  return {
    todoId: details.todoId,
    ...(typeof details.sessionId === "string" ? { sessionId: details.sessionId } : {}),
    message: cause.message,
  };
}

export function projectTodoStartDiscussionRecovery(cause: unknown): Omit<ProjectTodoDiscussionStartRecovery, "content"> | null {
  if (!(cause instanceof ApiError) || cause.details === null || typeof cause.details !== "object") return null;
  const details = cause.details as Record<string, unknown>;
  if (details.scopeCode !== "PROJECT_TODO_START_DISCUSSION_RECOVERY_REQUIRED"
    || typeof details.todoId !== "string"
    || typeof details.sessionId !== "string") return null;
  return { todoId: details.todoId, sessionId: details.sessionId, message: cause.message };
}

export function todoFlatListEmptyMessage(view: Exclude<TodoSurface, "active">, filtered: boolean): string {
  return filtered ? `No ${view} Todos match this filter.` : `No ${view} Todos yet.`;
}

export function deriveProjectTodoGroups(todos: readonly ProjectTodo[]): Record<ProjectTodoLane, ProjectTodo[]> {
  const groups: Record<ProjectTodoLane, ProjectTodo[]> = { idea: [], ready: [], in_progress: [], done: [] };
  for (const todo of todos) {
    if (todo.archivedAt === undefined && todo.status !== "rejected") groups[todo.status].push(todo);
  }
  return groups;
}

function deriveBoardOrder(todos: readonly ProjectTodo[]): BoardOrder {
  const groups = deriveProjectTodoGroups(todos);
  return Object.fromEntries(LANES.map((lane) => [lane, groups[lane].map((todo) => todo.id)])) as BoardOrder;
}

function locateTodo(order: BoardOrder, todoId: string): { lane: ProjectTodoLane; index: number } | undefined {
  for (const lane of LANES) {
    const index = order[lane].indexOf(todoId);
    if (index !== -1) return { lane, index };
  }
  return undefined;
}

/** Component-local projection used exclusively during a drag; server order remains authoritative. */
export function moveTodoInBoard(order: BoardOrder, todoId: string, destination: ProjectTodoLane, destinationIndex: number): BoardOrder {
  const source = locateTodo(order, todoId);
  if (!source) return order;
  const next: BoardOrder = { idea: [...order.idea], ready: [...order.ready], in_progress: [...order.in_progress], done: [...order.done] };
  const [moved] = next[source.lane].splice(source.index, 1);
  if (!moved) return order;
  next[destination].splice(Math.max(0, Math.min(destinationIndex, next[destination].length)), 0, moved);
  return next;
}

/** Pointer/touch follows the pointer; keyboard dragging retains geometric fallback. */
export const pointerFirstCollisionDetection: CollisionDetection = (args) => (
  args.pointerCoordinates === null ? closestCorners(args) : pointerWithin(args)
);

export function ProjectTodosRoute() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: todos = [], isLoading, error } = useProjectTodos(slug);
  const sessionInventory = useSessionInventory(slug);
  const automationInventory = useAutomationInventory(slug);
  const sessions = useMemo(() => (sessionInventory.data ?? []).map((item) => item.session), [sessionInventory.data]);
  const automations = useMemo(() => (automationInventory.data ?? []).map((item) => item.automation), [automationInventory.data]);
  const runtimeFamilies = useSessionRuntimeFamilies();
  const runtimeInitialized = useSessionRuntimeInitialized(slug);
  const attention = useAttentionVisibleScopedHitl([slug]);
  const hitlInitialized = useHitlProjectInitialized(slug);
  const createTodo = useCreateProjectTodo();
  const createSession = useCreateProjectTodoSession();
  const runNow = useRunProjectTodoNow();
  const startDiscussion = useStartProjectTodoDiscussion();
  const updateTodo = useUpdateProjectTodo();

  const requestedSurface = searchParams.get("surface");
  const surface: TodoSurface = requestedSurface === "rejected" || requestedSurface === "archived" ? requestedSurface : "active";
  const layout: ActiveLayout = searchParams.get("layout") === "board" ? "board" : "list";
  const query = searchParams.get("q") ?? "";
  const focusedTodoId = searchParams.get("focus");
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [runNowRecovery, setRunNowRecovery] = useState<ProjectTodoRunNowRecovery | null>(null);
  const [discussionRecovery, setDiscussionRecovery] = useState<ProjectTodoDiscussionStartRecovery | null>(null);
  const [captureFailureAction, setCaptureFailureAction] = useState<"save" | "discussion" | "run" | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [temporaryOrder, setTemporaryOrder] = useState<BoardOrder | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const saveOperationRef = useRef<{ content: string; slug: string } | null>(null);
  const runNowRequestRef = useRef<{ requestId: string; content: string; slug: string } | null>(null);
  const discussionRequestRef = useRef<{ requestId: string; content: string; slug: string } | null>(null);
  const mountedRef = useRef(false);
  const currentSlugRef = useRef(slug);
  const previousSlugRef = useRef(slug);
  currentSlugRef.current = slug;
  const scrollRef = useRef<HTMLDivElement>(null);
  const newTodoTriggerRef = useRef<HTMLButtonElement>(null);
  const captureInputRef = useRef<HTMLTextAreaElement>(null);
  const originFocusRef = useRef<HTMLElement | null>(null);
  const modalOpenRef = useRef(false);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const scrollStorageKey = `archcode.todo-inventory-scroll:${slug}`;

  const activityBySessionId = useMemo(() => new Map((sessionInventory.data ?? []).map(({ session }) => [
    session.sessionId,
    runtimeFamilies[runtimeFamilyKey(slug, session.sessionId)]?.activity ?? "idle",
  ])), [runtimeFamilies, sessionInventory.data, slug]);
  const attentionBySessionId = useMemo(() => {
    const labels = new Map<string, ProjectTodoAttentionLabel>();
    for (const entry of attention) {
      const label = entry.view.requiresInspection === true
        ? "Inspection"
        : entry.view.source.type === "tool_permission" ? "Permission" : "Question";
      if (label === "Inspection" || label === "Permission" || !labels.has(entry.rootSessionId)) labels.set(entry.rootSessionId, label);
    }
    return labels;
  }, [attention]);
  const operationalStateByTodoId = useMemo(() => {
    const authoritative = sessionInventory.isSuccess && automationInventory.isSuccess && runtimeInitialized && hitlInitialized;
    return new Map(todos.flatMap((todo) => {
      const state = deriveProjectTodoOperationalState({
        todo,
        sessions: sessionInventory.data ?? [],
        automations: automationInventory.data ?? [],
        activityBySessionId,
        attentionBySessionId,
        authoritative,
      });
      return state === undefined ? [] : [[todo.id, state] as const];
    }));
  }, [activityBySessionId, attentionBySessionId, automationInventory.data, automationInventory.isSuccess, hitlInitialized, runtimeInitialized, sessionInventory.data, sessionInventory.isSuccess, todos]);
  const filteredTodos = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return todos;
    return todos.filter((todo) => {
      const linkedSessions = sessions.filter((session) => session.source?.kind === "todo" && session.source.todoId === todo.id);
      const linkedAutomations = automations.filter((automation) => automation.origin.kind === "todo" && automation.origin.todoId === todo.id);
      const operational = operationalStateByTodoId.get(todo.id);
      return [
        todo.id,
        todo.content,
        operational?.label ?? "",
        operational?.detail ?? "",
        ...linkedSessions.map((session) => session.title ?? session.sessionId),
        ...linkedAutomations.map((automation) => automation.name),
      ].some((value) => value.toLocaleLowerCase().includes(needle));
    });
  }, [automations, operationalStateByTodoId, query, sessions, todos]);
  const activeTodos = useMemo(() => filteredTodos.filter((todo) => todo.archivedAt === undefined && todo.status !== "rejected"), [filteredTodos]);
  const groups = useMemo(() => deriveProjectTodoGroups(activeTodos), [activeTodos]);
  const canonicalOrder = useMemo(() => deriveBoardOrder(activeTodos), [activeTodos]);
  const boardOrder = temporaryOrder ?? canonicalOrder;
  const todoById = useMemo(() => new Map(todos.map((todo) => [todo.id, todo])), [todos]);
  const filteredTodoById = useMemo(() => new Map(activeTodos.map((todo) => [todo.id, todo])), [activeTodos]);
  const selectedTodo = selectedTodoId === null ? undefined : todoById.get(selectedTodoId);
  const visualTodoIds = useMemo(() => LANES.flatMap((lane) => canonicalOrder[lane]), [canonicalOrder]);
  const capturePending = createTodo.isPending || runNow.isPending || startDiscussion.isPending;
  modalOpenRef.current = captureOpen || selectedTodo !== undefined;
  const announcements = useMemo(() => createDragAnnouncements(boardOrder, filteredTodoById), [boardOrder, filteredTodoById]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const updateUrl = (change: { surface?: TodoSurface; layout?: ActiveLayout; query?: string; focus?: string | null }) => {
    const next = new URLSearchParams(searchParams);
    if (change.surface !== undefined) change.surface === "active" ? next.delete("surface") : next.set("surface", change.surface);
    if (change.layout !== undefined) change.layout === "list" ? next.delete("layout") : next.set("layout", change.layout);
    if (change.query !== undefined) change.query ? next.set("q", change.query) : next.delete("q");
    if (change.focus !== undefined) change.focus ? next.set("focus", change.focus) : next.delete("focus");
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (previousSlugRef.current === slug) return;
    previousSlugRef.current = slug;
    setCaptureOpen(false);
    setNewContent("");
    setCreateError(null);
    setRunNowRecovery(null);
    setDiscussionRecovery(null);
    setCaptureFailureAction(null);
    saveOperationRef.current = null;
    runNowRequestRef.current = null;
    discussionRequestRef.current = null;
  }, [slug]);
  useEffect(() => {
    const saved = window.sessionStorage.getItem(scrollStorageKey);
    if (saved !== null && scrollRef.current !== null) scrollRef.current.scrollTop = Number(saved) || 0;
    return () => window.sessionStorage.setItem(scrollStorageKey, String(scrollRef.current?.scrollTop ?? 0));
  }, [scrollStorageKey]);
  useEffect(() => {
    if (focusedTodoId === null) return;
    requestAnimationFrame(() => {
      if (!modalOpenRef.current) itemRefs.current.get(focusedTodoId)?.focus({ preventScroll: true });
    });
  }, [focusedTodoId, layout, surface]);
  const closePreview = (restoreFocus = true) => {
    if (selectedTodoId === null) return;
    setSelectedTodoId(null);
    if (restoreFocus) requestAnimationFrame(() => originFocusRef.current?.focus());
  };
  const openDetails = (todoId: string) => {
    window.sessionStorage.setItem(scrollStorageKey, String(scrollRef.current?.scrollTop ?? 0));
    navigate(`/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(todoId)}`, { state: { fromTodos: true } });
  };
  const selectTodo = (todoId: string, trigger: HTMLElement) => {
    updateUrl({ focus: todoId });
    if (surface !== "active" || window.matchMedia("(max-width: 720px)").matches) {
      openDetails(todoId);
      return;
    }
    originFocusRef.current = trigger;
    setSelectedTodoId(todoId);
  };
  const openCapture = () => {
    if (captureOpen) return;
    closePreview(false);
    setCreateError(null);
    setCaptureFailureAction(null);
    setConfirmation(null);
    setCaptureOpen(true);
  };
  const resetCapture = (restoreFocus: boolean) => {
    setCaptureOpen(false);
    setNewContent("");
    setCreateError(null);
    setRunNowRecovery(null);
    setDiscussionRecovery(null);
    setCaptureFailureAction(null);
    saveOperationRef.current = null;
    runNowRequestRef.current = null;
    discussionRequestRef.current = null;
    if (restoreFocus) requestAnimationFrame(() => newTodoTriggerRef.current?.focus());
  };
  const closeCapture = () => {
    if (capturePending) return;
    resetCapture(true);
  };
  const setCaptureContent = (value: string) => {
    setNewContent(value);
    setCreateError(null);
    setCaptureFailureAction(null);
    setConfirmation(null);
    saveOperationRef.current = null;
    runNowRequestRef.current = null;
    discussionRequestRef.current = null;
  };
  const blockedRunNowRecovery = runNowRecovery?.content === newContent.trim() ? runNowRecovery : null;
  const blockedDiscussionRecovery = discussionRecovery?.content === newContent.trim() ? discussionRecovery : null;

  const create = () => {
    const content = newContent.trim();
    if (!content) {
      setCreateError("Todo content is required");
      setCaptureFailureAction(null);
      captureInputRef.current?.focus();
      return;
    }
    const operation = { content, slug };
    saveOperationRef.current = operation;
    setCreateError(null);
    setCaptureFailureAction(null);
    createTodo.mutate({ slug, input: { content } }, {
      onSuccess: ({ todo }) => {
        if (!mountedRef.current || currentSlugRef.current !== operation.slug || saveOperationRef.current !== operation) return;
        resetCapture(true);
        setConfirmation("Todo saved to Ideas.");
        updateUrl({ surface: "active", layout, focus: todo.id });
      },
      onError: (cause) => {
        if (!mountedRef.current || currentSlugRef.current !== operation.slug || saveOperationRef.current !== operation) return;
        setCaptureFailureAction("save");
        setCreateError(messageFor(cause));
      },
    });
  };
  const run = () => {
    const content = newContent.trim();
    if (!content) {
      setCreateError("Todo content is required");
      setCaptureFailureAction(null);
      captureInputRef.current?.focus();
      return;
    }
    const previous = runNowRequestRef.current;
    const operation = previous?.content === content && previous.slug === slug
      ? previous
      : { requestId: createClientUuid(), content, slug };
    runNowRequestRef.current = operation;
    setCreateError(null);
    setCaptureFailureAction(null);
    runNow.mutate({ slug, clientRequestId: operation.requestId, content }, {
      onSuccess: ({ session }) => {
        if (!mountedRef.current || currentSlugRef.current !== operation.slug || runNowRequestRef.current !== operation) return;
        runNowRequestRef.current = null;
        setRunNowRecovery(null);
        resetCapture(false);
        navigate(`/projects/${encodeURIComponent(operation.slug)}/sessions/${encodeURIComponent(session.sessionId)}`);
      },
      onError: (cause) => {
        if (!mountedRef.current || currentSlugRef.current !== operation.slug || runNowRequestRef.current !== operation) return;
        const recovery = projectTodoRunNowRecovery(cause);
        if (recovery !== null) {
          runNowRequestRef.current = null;
          setCreateError(null);
          setCaptureFailureAction(null);
          setRunNowRecovery({ ...recovery, content });
          return;
        }
        setCaptureFailureAction("run");
        setCreateError(messageFor(cause));
      },
    });
  };
  const discuss = () => {
    const content = newContent.trim();
    if (!content) {
      setCreateError("Todo content is required");
      setCaptureFailureAction(null);
      captureInputRef.current?.focus();
      return;
    }
    const previous = discussionRequestRef.current;
    const operation = previous?.content === content && previous.slug === slug
      ? previous
      : { requestId: createClientUuid(), content, slug };
    discussionRequestRef.current = operation;
    setCreateError(null);
    setCaptureFailureAction(null);
    startDiscussion.mutate({ slug, clientRequestId: operation.requestId, content }, {
      onSuccess: ({ session }) => {
        if (!mountedRef.current || currentSlugRef.current !== operation.slug || discussionRequestRef.current !== operation) return;
        discussionRequestRef.current = null;
        setDiscussionRecovery(null);
        resetCapture(false);
        navigate(`/projects/${encodeURIComponent(operation.slug)}/sessions/${encodeURIComponent(session.sessionId)}`);
      },
      onError: (cause) => {
        if (!mountedRef.current || currentSlugRef.current !== operation.slug || discussionRequestRef.current !== operation) return;
        const recovery = projectTodoStartDiscussionRecovery(cause);
        if (recovery !== null) {
          discussionRequestRef.current = null;
          setCreateError(null);
          setCaptureFailureAction(null);
          setDiscussionRecovery({ ...recovery, content });
          return;
        }
        setCaptureFailureAction("discussion");
        setCreateError(messageFor(cause));
      },
    });
  };

  const sessionsFor = (todoId: string, entry?: "discussion" | "work") => sessions
    .filter((session) => session.source?.kind === "todo" && session.source.todoId === todoId && (entry === undefined || session.source.entry === entry))
    .sort(compareSessionUpdated);
  const startEntry = (todo: ProjectTodo, entry: "discussion" | "work") => {
    setCreateError(null);
    createSession.mutate({ slug, todoId: todo.id, input: { expectedRevision: todo.revision, entry } }, {
      onSuccess: ({ sessionId }) => navigate(`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`),
      onError: (cause) => setCreateError(messageFor(cause)),
    });
  };
  const continueWork = (todo: ProjectTodo, sessionId: string) => {
    const go = () => navigate(`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`);
    if (todo.status === "ready") {
      updateTodo.mutate({ slug, todoId: todo.id, input: { expectedRevision: todo.revision, status: "in_progress" } }, { onSuccess: go, onError: (cause) => setCreateError(messageFor(cause)) });
    } else go();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = target?.closest("input, textarea, select, [contenteditable=true]") !== null;
      if (captureOpen) return;
      if (event.key === "Escape" && selectedTodoId !== null) {
        event.preventDefault();
        closePreview();
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLocaleLowerCase() === "c") {
        event.preventDefault();
        openCapture();
        return;
      }
      if (surface !== "active") return;
      if (event.key === "j" || event.key === "k") {
        if (visualTodoIds.length === 0) return;
        event.preventDefault();
        const current = focusedTodoId === null ? -1 : visualTodoIds.indexOf(focusedTodoId);
        const delta = event.key === "j" ? 1 : -1;
        const index = current === -1 ? (delta > 0 ? 0 : visualTodoIds.length - 1) : Math.max(0, Math.min(visualTodoIds.length - 1, current + delta));
        const nextId = visualTodoIds[index];
        if (nextId === undefined) return;
        updateUrl({ focus: nextId });
        if (selectedTodoId !== null) setSelectedTodoId(nextId);
        else requestAnimationFrame(() => itemRefs.current.get(nextId)?.focus());
        return;
      }
      if (event.key === "Enter") {
        const targetId = selectedTodoId ?? focusedTodoId;
        if (targetId !== null && todoById.has(targetId)) {
          event.preventDefault();
          openDetails(targetId);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const resolveDrop = (overId: string | null): { lane: ProjectTodoLane; index: number } | undefined => {
    if (!overId) return undefined;
    if (isLane(overId)) return { lane: overId, index: boardOrder[overId].length };
    const target = locateTodo(boardOrder, overId);
    return target ? { lane: target.lane, index: target.index } : undefined;
  };
  const onDragStart = ({ active }: DragStartEvent) => {
    setReorderError(null);
    setDraggedId(String(active.id));
    setTemporaryOrder(canonicalOrder);
  };
  const onDragOver = ({ active, over }: DragOverEvent) => {
    const todoId = String(active.id);
    const destination = resolveDrop(over ? String(over.id) : null);
    if (destination) setTemporaryOrder((previous) => moveTodoInBoard(previous ?? canonicalOrder, todoId, destination.lane, destination.index));
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const todoId = String(active.id);
    const todo = filteredTodoById.get(todoId);
    const destination = resolveDrop(over ? String(over.id) : null);
    const finalOrder = temporaryOrder ?? canonicalOrder;
    setDraggedId(null);
    if (!todo || !destination) {
      setTemporaryOrder(null);
      return;
    }
    const result = locateTodo(finalOrder, todoId);
    if (!result) {
      setTemporaryOrder(null);
      return;
    }
    const beforeTodoId = finalOrder[result.lane][result.index + 1] ?? null;
    const stateChanged = todo.status !== result.lane;
    const positionChanged = canonicalOrder[result.lane].indexOf(todoId) !== result.index || stateChanged;
    if (!positionChanged) {
      setTemporaryOrder(null);
      return;
    }
    updateTodo.mutate({
      slug,
      todoId,
      input: { expectedRevision: todo.revision, ...(stateChanged ? { status: result.lane } : {}), beforeTodoId },
    }, {
      onSuccess: () => setTemporaryOrder(null),
      onError: (cause) => {
        setTemporaryOrder(null);
        setReorderError(messageFor(cause));
      },
    });
  };

  if (isLoading) return <div className="flex h-full items-center justify-center text-sm text-text-tertiary">Loading Todos…</div>;
  if (error) return <div className="flex h-full items-center justify-center text-sm text-error">Failed to load Todos</div>;

  const flatTodos = surface === "archived"
    ? filteredTodos.filter((todo) => todo.archivedAt !== undefined)
    : filteredTodos.filter((todo) => todo.archivedAt === undefined && todo.status === "rejected");

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-bg-base">
      <header className="grid min-h-[108px] shrink-0 grid-cols-1 items-center gap-2 border-b border-border-default bg-bg-surface px-3 py-2.5 min-[761px]:min-h-[58px] min-[761px]:grid-cols-[minmax(0,1fr)_auto] min-[761px]:gap-3 min-[761px]:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <label className="group flex h-11 w-full max-w-none min-w-0 items-center gap-2 rounded-sm border border-border-subtle bg-[color-mix(in_srgb,var(--bg-base)_82%,var(--bg-surface))] py-0 pl-3 pr-1 text-text-tertiary shadow-[inset_0_1px_0_rgb(255_255_255/3%)] transition-[border-color,background-color,box-shadow] duration-[var(--motion-hover)] hover:border-border-default hover:bg-bg-elevated focus-within:border-brand focus-within:bg-bg-elevated focus-within:[box-shadow:var(--focus)] min-[761px]:h-[38px] min-[761px]:max-w-[420px]">
            <Search className="shrink-0 transition-colors duration-[var(--motion-hover)] group-focus-within:text-brand" size={14} aria-hidden="true" />
            <span className="sr-only">Filter Todos</span>
            <input type="search" value={query} onChange={(event) => updateUrl({ query: event.target.value, focus: null })} placeholder="Filter Todos…" autoComplete="off" spellCheck={false} className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent px-0.5 text-[16px] text-text-primary outline-none placeholder:text-text-tertiary [&::-webkit-search-cancel-button]:appearance-none min-[761px]:text-[12px]" />
            {query ? <button type="button" aria-label="Clear Todo filter" onClick={() => updateUrl({ query: "", focus: null })} className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"><X size={12} aria-hidden="true" /></button> : null}
          </label>
          <div className="flex shrink-0 items-center gap-px rounded-sm border border-border-subtle bg-bg-surface p-0.5" role="group" aria-label="Active layout">
            <IconToggle label="List layout" active={layout === "list"} disabled={surface !== "active"} onClick={() => updateUrl({ layout: "list" })}><LayoutList size={14} /></IconToggle>
            <IconToggle label="Board layout" active={layout === "board"} disabled={surface !== "active"} onClick={() => updateUrl({ layout: "board" })}><Columns3 size={14} /></IconToggle>
          </div>
        </div>
        <div className="flex w-full items-center gap-2 min-[761px]:w-auto">
          <div className="grid min-w-0 flex-1 grid-cols-3 rounded-sm border border-border-default bg-bg-muted p-[3px] min-[761px]:min-w-[268px]" role="group" aria-label="Todo surfaces">
            <SegmentButton active={surface === "active"} onClick={() => { closePreview(); updateUrl({ surface: "active" }); }}>Active</SegmentButton>
            <SegmentButton active={surface === "rejected"} onClick={() => { closePreview(); updateUrl({ surface: "rejected" }); }}>Rejected</SegmentButton>
            <SegmentButton active={surface === "archived"} onClick={() => { closePreview(); updateUrl({ surface: "archived" }); }}>Archived</SegmentButton>
          </div>
          <PrimaryActionButton ref={newTodoTriggerRef} className="min-[761px]:h-9" aria-keyshortcuts="C" onClick={openCapture}><Plus size={14} />New Todo</PrimaryActionButton>
        </div>
      </header>
      {confirmation ? <p role="status" aria-live="polite" className="shrink-0 border-b border-success/20 bg-success-muted px-5 py-2 text-[11px] text-success">{confirmation}</p> : null}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-auto px-3 pb-8 pt-[14px] min-[761px]:px-5 min-[761px]:pb-10 min-[761px]:pt-4">
          {surface === "active" && activeTodos.length === 0 ? <EmptyFilter filtered={query.trim().length > 0} /> : null}
          {surface === "active" && layout === "list" && activeTodos.length > 0 ? (
            <ActiveTodoList groups={groups} operationalStateByTodoId={operationalStateByTodoId} focusedTodoId={focusedTodoId} selectedTodoId={selectedTodoId} itemRefs={itemRefs} onSelect={selectTodo} />
          ) : null}
          {surface === "active" && layout === "board" && activeTodos.length > 0 ? (
            <DndContext sensors={sensors} collisionDetection={pointerFirstCollisionDetection} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => { setDraggedId(null); setTemporaryOrder(null); }} accessibility={{ announcements }}>
              <div className={`mx-auto grid max-w-[1500px] grid-cols-1 gap-7 min-[700px]:grid-cols-2 min-[1100px]:grid-cols-4 ${draggedId ? "cursor-grabbing [&_*]:cursor-grabbing" : ""}`} data-testid="todo-board">
                {LANES.map((lane) => <TodoLane key={lane} lane={lane} order={boardOrder[lane]} todoById={filteredTodoById} operationalStateByTodoId={operationalStateByTodoId} focusedTodoId={focusedTodoId} selectedTodoId={selectedTodoId} itemRefs={itemRefs} onSelect={selectTodo} />)}
              </div>
              <DragOverlay dropAnimation={null}>{draggedId ? <DragPreview todo={filteredTodoById.get(draggedId)} /> : null}</DragOverlay>
            </DndContext>
          ) : null}
          {surface !== "active" ? <TodoFlatList view={surface} todos={flatTodos} filtered={query.trim().length > 0} slug={slug} updateTodo={updateTodo} onSelect={selectTodo} /> : null}
        </div>
        {selectedTodo && !captureOpen ? <TodoPreview key={selectedTodo.id} todo={selectedTodo} slug={slug} operationalState={operationalStateByTodoId.get(selectedTodo.id)} sessions={sessionsFor(selectedTodo.id)} onClose={closePreview} onOpenDetails={() => openDetails(selectedTodo.id)} onOpenSession={(sessionId) => navigate(`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`)} onStart={startEntry} onContinueWork={continueWork} /> : null}
      </div>
      {reorderError ? <p role="alert" className="shrink-0 border-t border-error/20 bg-error-muted px-5 py-3 text-[11px] text-error">Could not move Todo: {reorderError}</p> : null}
      {captureOpen ? <NewTodoDialog inputRef={captureInputRef} content={newContent} error={createError} failureAction={captureFailureAction} recovery={blockedRunNowRecovery} discussionRecovery={blockedDiscussionRecovery} slug={slug} pending={capturePending} savePending={createTodo.isPending} discussionPending={startDiscussion.isPending} runPending={runNow.isPending} onContent={setCaptureContent} onClose={closeCapture} onSave={create} onDiscuss={discuss} onRun={run} /> : null}
    </div>
  );
}

function ActiveTodoList({ groups, operationalStateByTodoId, focusedTodoId, selectedTodoId, itemRefs, onSelect }: {
  groups: Record<ProjectTodoLane, ProjectTodo[]>;
  operationalStateByTodoId: ReadonlyMap<string, ProjectTodoOperationalState>;
  focusedTodoId: string | null;
  selectedTodoId: string | null;
  itemRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  onSelect: (id: string, trigger: HTMLElement) => void;
}) {
  return <div className="mx-auto grid max-w-[980px] gap-[22px]" data-testid="todo-active-list">{LANES.map((lane) => {
    const presentation = PROJECT_TODO_LANE_PRESENTATIONS[lane];
    const { Icon } = presentation;
    return <section key={lane} aria-labelledby={`todo-list-${lane}`}>
      <header className="flex min-h-9 items-center gap-2.5 border-b border-border-subtle px-1 pb-2 text-text-tertiary"><Icon size={14} className={STATUS_TONE_CLASS[presentation.tone]} /><h2 id={`todo-list-${lane}`} className="text-[12px] font-bold uppercase tracking-[0.04em] text-text-secondary">{presentation.title}</h2><p className="min-w-0 flex-1 truncate text-[12px] text-text-muted">{presentation.hint}</p><span className="font-mono text-[11px] font-semibold tabular-nums text-text-secondary">{groups[lane].length}</span></header>
      <div className="divide-y divide-border-subtle">{groups[lane].length ? groups[lane].map((todo) => <TodoListRow key={todo.id} todo={todo} operationalState={operationalStateByTodoId.get(todo.id)} focused={focusedTodoId === todo.id} selected={selectedTodoId === todo.id} itemRefs={itemRefs} onSelect={onSelect} />) : <p className="px-8 py-4 text-[11px] text-text-tertiary">{presentation.emptyTitle}</p>}</div>
    </section>;
  })}</div>;
}

function TodoListRow({ todo, operationalState, focused, selected, itemRefs, onSelect }: {
  todo: ProjectTodo;
  operationalState?: ProjectTodoOperationalState;
  focused: boolean;
  selected: boolean;
  itemRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  onSelect: (id: string, trigger: HTMLElement) => void;
}) {
  const presentation = PROJECT_TODO_LANE_PRESENTATIONS[todo.status as ProjectTodoLane];
  const { Icon } = presentation;
  return <button ref={(node) => { node ? itemRefs.current.set(todo.id, node) : itemRefs.current.delete(todo.id); }} type="button" data-testid={`todo-open-${todo.id}`} onClick={(event) => onSelect(todo.id, event.currentTarget)} className={`grid min-h-14 w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border-subtle px-3 py-2.5 text-left transition-[background-color,box-shadow] duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${focused || selected ? "bg-bg-hover shadow-[inset_2px_0_0_var(--brand)]" : ""}`}>
    <Icon size={14} className={operationalState ? STATUS_TONE_CLASS[toneForOperational(operationalState)] : STATUS_TONE_CLASS[presentation.tone]} aria-hidden="true" />
    <span className="grid min-w-0 gap-1 px-1.5 py-px"><span className="block truncate text-[14px] font-medium leading-[1.35] text-text-primary">{projectTodoDisplayLead(todo.content)}</span><span className="flex flex-wrap items-center gap-2 text-[11px] tracking-normal text-text-muted"><span>Updated&nbsp;<RelativeTime timestamp={todo.updatedAt} style="short" /></span>{operationalState ? <OperationalLine state={operationalState} todoId={todo.id} compact /> : null}</span></span>
  </button>;
}

function TodoLane({ lane, order, todoById, operationalStateByTodoId, focusedTodoId, selectedTodoId, itemRefs, onSelect }: {
  lane: ProjectTodoLane;
  order: string[];
  todoById: Map<string, ProjectTodo>;
  operationalStateByTodoId: ReadonlyMap<string, ProjectTodoOperationalState>;
  focusedTodoId: string | null;
  selectedTodoId: string | null;
  itemRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  onSelect: (id: string, trigger: HTMLElement) => void;
}) {
  const presentation = PROJECT_TODO_LANE_PRESENTATIONS[lane];
  const { Icon } = presentation;
  const { setNodeRef, isOver } = useDroppable({ id: lane, data: { type: "lane", lane } });
  return <section ref={setNodeRef} className={`min-h-40 ${isOver ? "bg-selection-field" : "bg-transparent"} min-[761px]:min-h-[168px] min-[1100px]:min-h-[500px]`} aria-label={presentation.title} data-testid={`todo-lane-${lane}`}>
    <header className="grid min-h-[52px] grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-2.5 border-b border-border-subtle px-0.5 pb-[14px]"><span className={`mt-px grid h-4 w-4 place-items-center ${STATUS_TONE_CLASS[presentation.tone]}`}><Icon size={15} strokeWidth={1.9} data-icon={lane === "done" ? "circle-check" : undefined} /></span><div><h2 className="text-[11px] font-[720] uppercase tracking-[0.06em] text-text-secondary">{presentation.title}</h2><p className="mt-1 text-[11.5px] text-text-tertiary">{presentation.hint}</p></div><span className="-mt-0.5 min-w-[22px] self-center rounded-full border border-border-default bg-bg-elevated px-[7px] py-0.5 text-center text-[11px] font-bold tabular-nums text-text-secondary">{order.length}</span></header>
    <SortableContext items={order} strategy={verticalListSortingStrategy}><div className="grid gap-[11px] pt-[14px]">{order.length ? order.map((id) => { const todo = todoById.get(id); return todo ? <SortableTodoCard key={id} todo={todo} operationalState={operationalStateByTodoId.get(id)} focused={focusedTodoId === id} selected={selectedTodoId === id} itemRefs={itemRefs} onSelect={onSelect} /> : null; }) : <div className="mt-0.5 rounded-md border border-dashed border-[color:color-mix(in_srgb,var(--border-default)_80%,transparent)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--bg-muted)_55%,transparent),transparent)] px-[14px] py-[18px] pl-4 text-left"><span className="mb-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-[color:color-mix(in_srgb,var(--neutral)_8%,transparent)] text-neutral"><Icon size={16} aria-hidden="true" /></span><p className="text-[12.5px] font-[640] tracking-[-0.01em] text-text-secondary">{presentation.emptyTitle}</p><p className="mt-1.5 max-w-[280px] text-[11px] leading-[1.55] text-text-tertiary">{presentation.emptyHint}</p></div>}</div></SortableContext>
  </section>;
}

function SortableTodoCard({ todo, operationalState, focused, selected, itemRefs, onSelect }: {
  todo: ProjectTodo;
  operationalState?: ProjectTodoOperationalState;
  focused: boolean;
  selected: boolean;
  itemRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  onSelect: (id: string, trigger: HTMLElement) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: todo.id, data: { type: "todo", todo } });
  const excerpt = projectTodoDisplayLead(todo.content);
  return <article ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`group/todo-card workbench-row-lift grid min-h-14 grid-cols-[36px_minmax(0,1fr)] overflow-hidden rounded-md border border-border-subtle bg-bg-surface transition-[background,border-color,transform] duration-[var(--motion-hover)] hover:border-border-default hover:bg-bg-hover active:!translate-y-0 active:scale-[0.995] focus-within:border-[color:color-mix(in_srgb,var(--brand)_45%,var(--border-default))] focus-within:bg-selection-field focus-within:shadow-[inset_2px_0_0_var(--brand)] [@media(pointer:coarse)]:grid-cols-[44px_minmax(0,1fr)] ${focused || selected ? "todo-card-selected border-[color:color-mix(in_srgb,var(--brand)_45%,var(--border-default))] bg-selection-field" : ""} ${isDragging ? "opacity-35" : ""}`} data-testid={`todo-${todo.id}`}>
    <button ref={setActivatorNodeRef} type="button" className={`grid min-h-14 w-9 touch-none place-items-center self-stretch bg-transparent text-text-muted opacity-[0.35] transition-[color,opacity] duration-[var(--motion-hover)] group-hover/todo-card:opacity-[0.72] group-focus-within/todo-card:opacity-[0.72] hover:!text-text-primary hover:!opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand [@media(pointer:coarse)]:w-11 ${isDragging ? "cursor-grabbing text-brand opacity-100" : "cursor-grab active:cursor-grabbing"}`} aria-label={`Drag ${excerpt}`} {...attributes} {...listeners}><GripVertical size={16} /></button><button ref={(node) => { node ? itemRefs.current.set(todo.id, node) : itemRefs.current.delete(todo.id); }} type="button" data-testid={`todo-open-${todo.id}`} className="flex min-w-0 cursor-pointer flex-col justify-center bg-transparent py-2.5 pl-0 pr-3.5 text-left tracking-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand" onClick={(event) => onSelect(todo.id, event.currentTarget)}><span className={`line-clamp-2 text-[14px] font-medium leading-[1.5] tracking-[-0.012em] transition-colors duration-[var(--motion-hover)] group-hover/todo-card:text-text-primary ${focused || selected ? "text-text-primary" : "text-text-secondary"}`}>{excerpt}</span>{operationalState ? <OperationalLine state={operationalState} todoId={todo.id} /> : null}</button>
  </article>;
}

function OperationalLine({ state, todoId, compact = false }: { state: ProjectTodoOperationalState; todoId?: string; compact?: boolean }) {
  const detail = state.detail !== state.label ? state.detail : undefined;
  if (compact) return <span data-testid={todoId ? `todo-operational-${todoId}` : undefined} className={`inline-flex items-center gap-1.5 font-semibold ${STATUS_TONE_CLASS[toneForOperational(state)]}`}><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" /><span>{state.label}</span>{detail ? <span className="truncate text-text-tertiary">· {detail}</span> : null}</span>;
  return <span data-testid={todoId ? `todo-operational-${todoId}` : undefined} className={`mt-1.5 flex items-center gap-1.5 text-[11.5px] font-[520] leading-4 tracking-normal ${STATUS_TONE_CLASS[toneForOperational(state)]}`}><span className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${state.kind === "running" ? "animate-activity-pulse" : ""}`} aria-hidden="true" /><span>{state.label}</span>{detail ? <span className="truncate text-text-tertiary">· {detail}</span> : null}</span>;
}

function TodoPreview({ todo, slug, operationalState, sessions, onClose, onOpenDetails, onOpenSession, onStart, onContinueWork }: {
  todo: ProjectTodo;
  slug: string;
  operationalState?: ProjectTodoOperationalState;
  sessions: SessionSummary[];
  onClose: () => void;
  onOpenDetails: () => void;
  onOpenSession: (sessionId: string) => void;
  onStart: (todo: ProjectTodo, entry: "discussion" | "work") => void;
  onContinueWork: (todo: ProjectTodo, sessionId: string) => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const discussion = sessions.filter((session) => session.source?.kind === "todo" && session.source.entry === "discussion")[0];
  const work = sessions.filter((session) => session.source?.kind === "todo" && session.source.entry === "work")[0];
  const active = todo.status !== "rejected" && todo.archivedAt === undefined;
  const canExecute = active && (todo.status === "ready" || todo.status === "in_progress");
  const canDiscuss = active && todo.status !== "done";
  const runtimeVisible = operationalState !== undefined && (operationalState.kind === "needs_you" || operationalState.kind === "failed" || operationalState.kind === "running" || operationalState.kind === "completed");
  useEffect(() => {
    requestAnimationFrame(() => headingRef.current?.focus());
  }, []);
  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]") ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (document.activeElement === headingRef.current) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <><button type="button" tabIndex={-1} aria-label="Close Todo preview" onClick={onClose} className="animate-todo-preview-scrim absolute inset-0 z-20 cursor-pointer border-0 bg-[linear-gradient(90deg,rgb(15_23_42/3%)_0%,rgb(15_23_42/8%)_100%)] p-0 dark:bg-[linear-gradient(90deg,rgb(0_0_0/8%)_0%,rgb(0_0_0/14%)_100%)] max-[720px]:hidden" /><aside ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="todo-preview-heading" onKeyDown={trapFocus} className="animate-todo-preview-enter absolute inset-y-0 right-0 z-30 flex w-[min(420px,calc(100%-48px))] max-w-[420px] flex-col overflow-hidden border-l border-border-default bg-[linear-gradient(180deg,color-mix(in_srgb,var(--bg-elevated)_55%,var(--bg-surface))_0%,var(--bg-surface)_120px)] shadow-[-1px_0_0_color-mix(in_srgb,var(--border-subtle)_80%,transparent),-14px_0_36px_rgb(15_23_42/9%)] dark:shadow-[-1px_0_0_color-mix(in_srgb,var(--border-subtle)_70%,transparent),-16px_0_42px_rgb(0_0_0/18%)] max-[720px]:hidden" data-testid="todo-preview">
    <header className="flex min-h-[52px] shrink-0 items-center gap-2.5 border-b border-border-subtle py-3 pl-4 pr-[14px]"><span className="inline-flex min-w-0 flex-1 items-center gap-2 text-[11px] font-[650] uppercase tracking-[0.06em] text-text-tertiary"><span className="h-1.5 w-1.5 rounded-full bg-brand shadow-[0_0_0_3px_color-mix(in_srgb,var(--brand)_18%,transparent)]" aria-hidden="true" />Preview</span><button ref={closeRef} type="button" aria-label="Close preview" onClick={onClose} className="grid h-[30px] w-[30px] place-items-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"><X size={15} /></button><h1 ref={headingRef} id="todo-preview-heading" tabIndex={-1} className="sr-only">Todo detail</h1></header>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden"><div className="min-h-0 flex-1 overflow-auto px-[18px] pb-3 pt-[18px]"><h2 className="text-[18px] font-[680] leading-[1.28] tracking-[-0.03em] text-text-primary">{projectTodoDisplayLead(todo.content)}</h2><p className="mt-2.5 line-clamp-5 text-[13px] leading-[1.55] text-text-secondary">{projectTodoPreviewExcerpt(todo.content)}</p><div className="mt-[14px] flex flex-wrap gap-1.5"><span className="inline-flex min-h-6 items-center rounded-full border border-border-subtle bg-bg-muted px-[9px] text-[11px] font-semibold tabular-nums text-text-secondary">Updated&nbsp;<RelativeTime timestamp={todo.updatedAt} style="short" /></span><span className="inline-flex min-h-6 items-center rounded-full border border-border-subtle bg-bg-muted px-[9px] text-[11px] font-semibold text-text-primary">{labelForStatus(todo.status as ProjectTodoLane)}</span></div>
      {runtimeVisible && operationalState ? <div className={`mt-4 flex items-start gap-2.5 rounded-[10px] border p-3 pl-[14px] ${previewRuntimeSurface(operationalState)}`}><span className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${previewRuntimeMark(operationalState)}`} aria-hidden="true" /><span><strong className="block text-[12.5px] font-[650] tracking-[-0.01em] text-text-primary">{operationalState.label}</strong><span className="mt-[3px] block text-[12px] leading-[1.45] text-text-secondary">{previewRuntimeCopy(operationalState)}</span></span></div> : null}
      {sessions.length ? <section className="mt-[22px]"><h3 className="mb-2 text-[11px] font-[680] uppercase tracking-[0.05em] text-text-tertiary">Linked work</h3><div className="grid gap-1.5">{sessions.slice(0, 3).map((session) => { const discussionSession = session.source?.kind === "todo" && session.source.entry === "discussion"; const stateLabel = discussionSession ? "Discussion" : operationalState?.label ?? "Idle"; const stateTone = discussionSession ? "text-text-tertiary" : operationalState ? STATUS_TONE_CLASS[toneForOperational(operationalState)] : "text-text-tertiary"; const agent = `${session.agentName.slice(0, 1).toUpperCase()}${session.agentName.slice(1)}`; const detail = operationalState?.detail !== operationalState?.label ? operationalState?.detail : undefined; return <Link key={session.sessionId} to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(session.sessionId)}`} aria-label={`${session.title || session.sessionId}, ${discussionSession ? "Discussion" : "Work Session"}, ${stateLabel}`} className="grid min-h-[52px] grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[10px] border border-border-subtle bg-[color-mix(in_srgb,var(--bg-muted)_70%,transparent)] px-3 py-2.5 text-inherit transition-[background-color,border-color] duration-[var(--motion-hover)] hover:border-border-default hover:bg-bg-hover focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"><span className={`h-2 w-2 rounded-full ${discussionSession ? "bg-text-tertiary" : previewLinkedOrbit(operationalState)}`} aria-hidden="true" /><span className="min-w-0"><strong className="block truncate text-[12.5px] font-[620] text-text-primary">{session.title || session.sessionId}</strong><small className="mt-0.5 block truncate text-[11px] text-text-tertiary">{agent} · {discussionSession ? "Discussion" : detail ?? "Work Session"}</small></span><span className={`whitespace-nowrap text-[11px] font-[640] ${stateTone}`}>{stateLabel}</span></Link>; })}</div></section> : null}
      <p className="mt-[18px] text-[11px] leading-[1.45] text-text-tertiary">PRD, Plan, references, and linked history stay available on demand.</p>
    </div>
    <footer className="grid shrink-0 gap-2 border-t border-border-subtle bg-[linear-gradient(180deg,color-mix(in_srgb,var(--bg-surface)_82%,transparent),var(--bg-surface))] px-4 pb-4 pt-[14px]">{canExecute ? <TodoPreviewAction variant="primary" onClick={() => work ? onContinueWork(todo, work.sessionId) : onStart(todo, "work")}>{work ? "Continue Work" : "Start Work"}</TodoPreviewAction> : canDiscuss ? <TodoPreviewAction variant="primary" onClick={() => discussion ? onOpenSession(discussion.sessionId) : onStart(todo, "discussion")}>{discussion ? "Continue Discussion" : "New Discussion"}</TodoPreviewAction> : null}<div className={`grid gap-2 ${canExecute && canDiscuss ? "grid-cols-2" : "grid-cols-1"}`}><TodoPreviewAction variant="secondary" onClick={onOpenDetails}>Open details</TodoPreviewAction>{canExecute && canDiscuss ? <TodoPreviewAction variant="quiet" onClick={() => discussion ? onOpenSession(discussion.sessionId) : onStart(todo, "discussion")}>{discussion ? "Continue Discussion" : "New Discussion"}</TodoPreviewAction> : null}</div></footer>
    </div>
  </aside></>;
}

function NewTodoDialog({ inputRef, content, error, failureAction, recovery, discussionRecovery, slug, pending, savePending, discussionPending, runPending, onContent, onClose, onSave, onDiscuss, onRun }: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  content: string;
  error: string | null;
  failureAction: "save" | "discussion" | "run" | null;
  recovery: ProjectTodoRunNowRecovery | null;
  discussionRecovery: ProjectTodoDiscussionStartRecovery | null;
  slug: string;
  pending: boolean;
  savePending: boolean;
  discussionPending: boolean;
  runPending: boolean;
  onContent: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
  onDiscuss: () => void;
  onRun: () => void;
}) {
  const errorRef = useRef<HTMLParagraphElement>(null);
  const recoveryRef = useRef<HTMLDivElement>(null);
  const retryDiscussionRef = useRef<HTMLButtonElement>(null);
  const runRef = useRef<HTMLButtonElement>(null);
  const blocked = recovery !== null || discussionRecovery !== null;
  const pendingLabel = savePending ? "Saving Todo…" : discussionPending ? "Starting Discussion…" : runPending ? "Starting work…" : "";

  useEffect(() => {
    if (pending) return;
    const retryTarget = failureAction === "save" ? errorRef.current
      : failureAction === "discussion" ? retryDiscussionRef.current
        : failureAction === "run" ? runRef.current
          : null;
    const target = discussionRecovery || recovery ? recoveryRef.current : retryTarget ?? (error ? inputRef.current : null);
    if (target) requestAnimationFrame(() => target.focus());
  }, [discussionRecovery, error, failureAction, pending, recovery]);

  return <DialogPrimitive.Root open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="animate-todo-dialog-backdrop fixed inset-0 z-[70] bg-black/[0.58]" data-testid="new-todo-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }} />
      <DialogPrimitive.Content role="dialog" aria-modal="true" aria-labelledby="new-todo-title"
        aria-busy={pending}
        aria-describedby="new-todo-help new-todo-status"
        onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (pending) event.preventDefault(); }}
        onInteractOutside={(event) => { if (pending) event.preventDefault(); }}
        className="animate-todo-dialog fixed inset-0 z-[71] m-auto flex max-h-[calc(100dvh-20px)] w-[calc(100vw-20px)] flex-col overflow-hidden rounded-[var(--shape-dialog)] border border-border-default bg-bg-overlay shadow-lg outline-none min-[761px]:max-h-[min(680px,calc(100dvh-32px))] min-[761px]:w-[min(560px,calc(100vw-32px))]"
      >
        <header className="flex min-h-[52px] shrink-0 items-center gap-3 border-b border-border-subtle py-0 pl-[18px] pr-1.5 min-[761px]:pr-2.5">
          <div id="new-todo-title" className="flex-1 text-[15px] font-[640] text-text-primary"><DialogPrimitive.Title className="contents">New Todo</DialogPrimitive.Title></div>
          <button type="button" aria-label="Close New Todo" disabled={pending} onClick={onClose} className="grid h-11 w-11 shrink-0 place-items-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] min-[761px]:h-8 min-[761px]:w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"><X size={16} /></button>
        </header>
        <div className="min-h-0 overflow-y-auto p-4 min-[761px]:p-[18px]">
          <label htmlFor="new-todo-content" className="mb-2 block text-[12px] font-[620] text-text-secondary">Todo content</label>
          <textarea ref={inputRef} id="new-todo-content" rows={6} value={content} onChange={(event) => onContent(event.target.value)} disabled={pending} aria-describedby="new-todo-help" placeholder="Describe an idea, bug, feature, or paste a PRD…" className="h-[180px] min-h-[180px] max-h-[280px] w-full resize-y rounded-[8px] border border-border-control bg-bg-elevated px-[14px] py-3 text-[16px] leading-[1.6] text-text-primary outline-none focus:border-brand focus:[box-shadow:var(--focus)] disabled:opacity-60 min-[761px]:h-[126px] min-[761px]:min-h-[126px] min-[761px]:text-[15px]" />
          <div id="new-todo-help"><DialogPrimitive.Description className="mt-2.5 text-[11px] leading-[1.5] text-text-tertiary">Markdown is supported. Save it for later, shape it in a Discussion, or run it as a Lead Session.</DialogPrimitive.Description></div>
          <p id="new-todo-status" role="status" aria-live="polite" className="sr-only">{pendingLabel}</p>
          {error ? <p ref={errorRef} tabIndex={-1} role="alert" className="mt-3 text-[11px] text-error outline-none focus-visible:[box-shadow:var(--focus)]">{error}</p> : null}
          {recovery ? <div ref={recoveryRef} tabIndex={-1} role="alert" className="mt-3 border-l-2 border-error bg-error-muted px-3 py-2 text-[11px] leading-5 text-error outline-none focus-visible:[box-shadow:var(--focus)]"><p>{recovery.message} Do not retry this unchanged request; inspect the retained work first.</p><div className="flex flex-wrap gap-x-3"><Link className="font-medium underline" to={`/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(recovery.todoId)}`}>Open Todo {recovery.todoId}</Link>{recovery.sessionId ? <Link className="font-medium underline" to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(recovery.sessionId)}`}>Open Session {recovery.sessionId}</Link> : null}</div><p>Edit the Todo content before starting a different request.</p></div> : null}
          {discussionRecovery ? <div ref={recoveryRef} tabIndex={-1} role="alert" className="mt-3 border-l-2 border-error bg-error-muted px-3 py-2 text-[11px] leading-5 text-error outline-none focus-visible:[box-shadow:var(--focus)]"><p>{discussionRecovery.message} Inspect the retained work before starting another request.</p><div className="flex flex-wrap gap-x-3"><Link className="font-medium underline" to={`/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(discussionRecovery.todoId)}`}>Open Todo {discussionRecovery.todoId}</Link><Link className="font-medium underline" to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(discussionRecovery.sessionId)}`}>Open Session {discussionRecovery.sessionId}</Link></div><p>Edit the Todo content before starting a different operation.</p></div> : null}
        </div>
        <footer className="grid shrink-0 grid-cols-2 items-center gap-2.5 border-t border-border-subtle bg-bg-surface px-4 pb-4 pt-3 min-[761px]:flex min-[761px]:justify-end min-[761px]:px-[18px] min-[761px]:py-3">
          <button type="button" disabled={pending} onClick={onClose} className="hidden h-8 items-center justify-center rounded-sm px-2.5 text-[12px] font-semibold tracking-[-0.01em] text-text-secondary hover:bg-bg-hover disabled:opacity-40 min-[761px]:inline-flex [@media(pointer:coarse)]:!h-11">Cancel</button>
          <button type="button" disabled={pending || blocked} onClick={onSave} className="inline-flex h-11 items-center justify-center rounded-sm border border-border-default bg-bg-overlay px-[13px] text-[12px] font-semibold tracking-[-0.01em] text-text-secondary hover:border-border-strong hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 min-[761px]:h-8 [@media(pointer:coarse)]:!h-11">Save</button>
          <button ref={retryDiscussionRef} type="button" disabled={pending || blocked} onClick={onDiscuss} className="inline-flex h-11 items-center justify-center rounded-sm border border-border-default bg-bg-overlay px-[13px] text-[12px] font-semibold tracking-[-0.01em] text-text-secondary hover:border-brand hover:bg-brand-field hover:text-brand disabled:opacity-40 min-[761px]:h-8 [@media(pointer:coarse)]:!h-11">{discussionPending ? "Starting discussion…" : failureAction === "discussion" ? "Retry discussion" : "Start discussion"}</button>
          <button ref={runRef} type="button" disabled={pending || blocked} onClick={onRun} className="primary-action-button relative col-span-2 inline-flex h-11 items-center justify-center overflow-hidden rounded-sm border border-brand bg-brand px-[13px] text-[12px] font-semibold tracking-[-0.01em] text-brand-ink hover:border-brand-hover hover:bg-brand-hover disabled:border-bg-active disabled:bg-bg-active disabled:text-text-tertiary disabled:shadow-none min-[761px]:col-span-1 min-[761px]:h-8 [@media(pointer:coarse)]:!h-11">{runPending ? "Starting…" : failureAction === "run" ? "Retry run" : "Run now"}</button>
        </footer>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

function TodoFlatList({ view, todos, filtered, slug, updateTodo, onSelect }: {
  view: Exclude<TodoSurface, "active">;
  todos: ProjectTodo[];
  filtered: boolean;
  slug: string;
  updateTodo: ReturnType<typeof useUpdateProjectTodo>;
  onSelect: (id: string, trigger: HTMLElement) => void;
}) {
  return <section className="mx-auto max-w-[980px]" aria-label={view === "rejected" ? "Rejected Todos" : "Archived Todos"}><h2 className="border-b border-border-default pb-3 text-[12px] font-semibold uppercase tracking-[0.05em] text-text-secondary">{view === "rejected" ? "Rejected" : "Archived"}</h2>{todos.length === 0 ? <p className="py-16 text-center text-[13px] text-text-tertiary">{todoFlatListEmptyMessage(view, filtered)}</p> : <div className="divide-y divide-border-subtle">{todos.map((todo) => <TodoFlatRow key={todo.id} todo={todo} view={view} slug={slug} updateTodo={updateTodo} onSelect={onSelect} />)}</div>}</section>;
}

function TodoFlatRow({ todo, view, slug, updateTodo, onSelect }: {
  todo: ProjectTodo;
  view: Exclude<TodoSurface, "active">;
  slug: string;
  updateTodo: ReturnType<typeof useUpdateProjectTodo>;
  onSelect: (id: string, trigger: HTMLElement) => void;
}) {
  const presentation = presentProjectTodoCard({ status: todo.status as ProjectTodoStatus, archivedAt: todo.archivedAt });
  const { Icon } = presentation;
  const secondary = view === "rejected" ? `Rejected · ${todo.rejectionReason}` : "Archived";
  const displayLead = projectTodoDisplayLead(todo.content);
  return <div className="grid min-h-14 grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 hover:bg-bg-hover"><Icon aria-hidden="true" className={STATUS_TONE_CLASS[presentation.tone]} size={14} /><button type="button" data-testid={`todo-${todo.id}`} aria-label={`${displayLead}, ${secondary}`} onClick={(event) => onSelect(todo.id, event.currentTarget)} className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"><span className="line-clamp-2 text-[13px] font-medium leading-5 text-text-primary">{displayLead}</span><span className={`mt-1 block text-[11px] ${view === "rejected" ? "text-warning" : "text-text-tertiary"}`}>{secondary}</span></button><button type="button" disabled={updateTodo.isPending} onClick={() => updateTodo.mutate({ slug, todoId: todo.id, input: view === "rejected" ? { expectedRevision: todo.revision, status: "idea" } : { expectedRevision: todo.revision, archived: false } })} className="min-h-8 rounded-sm border border-border-default bg-bg-active px-2.5 text-[11px] font-semibold text-text-secondary hover:bg-bg-hover disabled:opacity-40 [@media(pointer:coarse)]:min-h-11">{view === "rejected" ? "Restore to Idea" : "Restore"}</button></div>;
}

function EmptyFilter({ filtered }: { filtered: boolean }) {
  return <div className="mx-auto max-w-[980px] py-16 text-center"><p className="text-[13px] font-medium text-text-secondary">{filtered ? "No active Todos match this filter." : "No active Todos yet."}</p><p className="mt-1 text-[11px] text-text-tertiary">{filtered ? "Try another ID, content, or visible work-state term." : "Create a Todo when you have work to shape."}</p></div>;
}

function DragPreview({ todo }: { todo?: ProjectTodo }) {
  return todo ? <div className="w-64 cursor-grabbing rounded-md border border-brand bg-bg-elevated p-3 shadow-lg"><p className="line-clamp-2 text-[13px] font-medium leading-5 text-text-primary">{projectTodoDisplayLead(todo.content)}</p></div> : null;
}

function SegmentButton({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`h-[30px] min-w-0 cursor-pointer rounded-sm px-2.5 text-[11px] font-semibold ${active ? "bg-bg-elevated text-text-primary shadow-sm" : "text-text-secondary hover:text-text-primary"}`}>{children}</button>;
}
function IconToggle({ children, label, active, disabled, onClick }: { children: React.ReactNode; label: string; active: boolean; disabled: boolean; onClick: () => void }) {
  return <button type="button" aria-label={label} title={label} aria-pressed={active} disabled={disabled} onClick={onClick} className={`grid h-9 w-9 min-w-9 cursor-pointer place-items-center rounded-sm focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] min-[761px]:h-7 min-[761px]:w-[30px] min-[761px]:min-w-[30px] ${active ? "bg-bg-muted text-text-primary" : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"} disabled:cursor-not-allowed disabled:opacity-35`}>{children}</button>;
}
function TodoPreviewAction({ children, variant, onClick }: { children: React.ReactNode; variant: "primary" | "secondary" | "quiet"; onClick: () => void }) {
  const visual = variant === "primary"
    ? "primary-action-button relative overflow-hidden border border-brand bg-brand px-[13px] text-brand-ink hover:-translate-y-px hover:border-brand-hover hover:bg-brand-hover active:translate-y-0 active:scale-[0.98]"
    : variant === "secondary"
      ? "border border-border-default bg-bg-elevated px-[13px] text-text-secondary hover:border-border-strong hover:bg-bg-hover hover:text-text-primary"
      : "border-0 bg-transparent px-2.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary";
  return <button type="button" onClick={onClick} className={`inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-sm text-[12px] font-semibold tracking-[-0.01em] transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--motion-hover)] focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(pointer:coarse)]:min-h-11 ${visual}`}>{children}</button>;
}

function compareSessionUpdated(left: SessionSummary, right: SessionSummary): number { return right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId); }
function toneForOperational(state: ProjectTodoOperationalState): StatusTone { return state.kind === "needs_you" ? "warning" : state.kind === "running" ? "signal" : state.kind === "completed" ? "brand" : state.kind === "failed" ? "error" : "neutral"; }
function labelForStatus(status: ProjectTodoLane): string { return status === "idea" ? "Idea" : status === "ready" ? "Ready" : status === "in_progress" ? "In Progress" : "Done"; }
function previewRuntimeSurface(state: ProjectTodoOperationalState): string {
  if (state.kind === "running") return "border-[color:color-mix(in_srgb,var(--signal)_24%,var(--border-subtle))] bg-signal-field";
  if (state.kind === "completed") return "border-[color:color-mix(in_srgb,var(--brand)_22%,var(--border-subtle))] bg-brand-field";
  if (state.kind === "failed") return "border-[color:color-mix(in_srgb,var(--error)_26%,var(--border-subtle))] bg-error-field";
  return "border-[color:color-mix(in_srgb,var(--warning)_26%,var(--border-subtle))] bg-attention-field";
}
function previewRuntimeMark(state: ProjectTodoOperationalState): string {
  if (state.kind === "running") return "border-[1.5px] border-signal-foreground bg-transparent";
  if (state.kind === "completed") return "bg-brand shadow-[0_0_0_3px_color-mix(in_srgb,var(--brand)_18%,transparent)]";
  if (state.kind === "failed") return "bg-error shadow-[0_0_0_3px_color-mix(in_srgb,var(--error)_18%,transparent)]";
  return "bg-warning shadow-[0_0_0_3px_color-mix(in_srgb,var(--warning)_18%,transparent)]";
}
function previewLinkedOrbit(state: ProjectTodoOperationalState | undefined): string {
  if (state?.kind === "running") return "border-[1.5px] border-signal-foreground bg-transparent";
  if (state?.kind === "needs_you") return "bg-warning";
  if (state?.kind === "failed") return "bg-error";
  if (state?.kind === "completed") return "bg-brand";
  return "bg-border-strong";
}
function previewRuntimeCopy(state: ProjectTodoOperationalState): string {
  const detail = state.detail !== state.label ? state.detail : undefined;
  if (state.kind === "needs_you") return detail === undefined ? "A bound Session is waiting before work can continue." : `Lead · ${detail}`;
  if (state.kind === "failed") return detail === undefined ? "The latest linked attempt failed and needs recovery." : `The latest linked attempt failed · ${detail}`;
  if (state.kind === "running") return detail === undefined ? "Execution is attached to this Todo." : `Lead · ${detail}`;
  return "Implementation is waiting for review.";
}
function isLane(value: string): value is ProjectTodoLane { return (LANES as readonly string[]).includes(value); }
function messageFor(cause: unknown): string { return cause instanceof Error ? cause.message : "Action failed"; }

export function createDragAnnouncements(order: BoardOrder, todoById: ReadonlyMap<string, ProjectTodo>) {
  const titleFor = (id: string | number) => todoById.get(String(id)) === undefined ? "Todo" : projectTodoDisplayLead(todoById.get(String(id))!.content);
  const describeTarget = (target: { lane: ProjectTodoLane; index: number } | undefined) => target ? `${PROJECT_TODO_LANE_PRESENTATIONS[target.lane].title}, position ${target.index + 1} of ${Math.max(1, order[target.lane].length, target.index + 1)}` : undefined;
  const targetFor = (overId: string | number) => {
    const id = String(overId);
    return describeTarget(isLane(id) ? { lane: id, index: order[id].length } : locateTodo(order, id));
  };
  return {
    onDragStart: ({ active }: { active: { id: string | number } }) => `Picked up ${titleFor(active.id)}.`,
    onDragOver: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) => {
      const target = over ? targetFor(over.id) : undefined;
      return target ? `Moving ${titleFor(active.id)} to ${target}.` : undefined;
    },
    onDragEnd: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) => {
      const target = describeTarget(locateTodo(order, String(active.id))) ?? (over ? targetFor(over.id) : undefined);
      return target ? `Dropped ${titleFor(active.id)} in ${target}.` : `Cancelled move for ${titleFor(active.id)}.`;
    },
    onDragCancel: ({ active }: { active: { id: string | number } }) => `Cancelled move for ${titleFor(active.id)}.`,
  };
}
