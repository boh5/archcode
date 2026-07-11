import { useEffect, useRef, useState } from "react";
import { Check, Circle, ListTodo, Loader2, X } from "lucide-react";
import type { SessionTodo } from "@archcode/protocol";
import { useSessionStore } from "../../store/session-store";
import { deriveTodoProgress, presentTodoContent, type TodoPriority, type TodoProgressState } from "../../lib/todo-progress";

const STATE_LABEL: Record<TodoProgressState, string> = {
  running: "Running",
  waiting: "Waiting",
  blocked: "Blocked",
  failed: "Failed",
  completed: "Completed",
  idle: "Ready",
};

const STATE_CLASS: Record<TodoProgressState, string> = {
  running: "text-accent border-accent/40 bg-accent-subtle",
  waiting: "text-warning border-warning/40 bg-warning-muted",
  blocked: "text-warning border-warning/40 bg-warning-muted",
  failed: "text-error border-error/40 bg-error-muted",
  completed: "text-success border-success/40 bg-success-muted",
  idle: "text-text-secondary border-border-default bg-bg-elevated",
};

const PRIORITY_LABEL: Record<TodoPriority, string> = {
  high: "P0",
  medium: "P1",
  low: "P2",
};

const PRIORITY_CLASS: Record<TodoPriority, string> = {
  high: "bg-error-muted text-error",
  medium: "bg-warning-muted text-warning",
  low: "bg-bg-active text-text-muted",
};

export function TodoProgressButton({ slug, sessionId }: { slug: string; sessionId: string }) {
  const todos = useSessionStore(sessionId, (state) => state.todos, slug);
  const isRunning = useSessionStore(sessionId, (state) => state.isRunning, slug);
  const executions = useSessionStore(sessionId, (state) => state.executions, slug);
  const blockedByHitlIds = useSessionStore(sessionId, (state) => state.blockedByHitlIds, slug);
  const lastExecution = executions.at(-1);
  const progress = deriveTodoProgress(todos, {
    isRunning,
    lastExecutionStatus: lastExecution?.status,
    blockedByHitlIds,
  });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const ignoreNextFocusPreview = useRef(false);
  const open = previewOpen || pinned;

  useEffect(() => {
    if (!pinned) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setPinned(false);
        setPreviewOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [pinned]);

  useEffect(() => {
    setPinned(false);
    setPreviewOpen(false);
  }, [sessionId]);

  useEffect(() => {
    if (todos.length === 0) {
      setPinned(false);
      setPreviewOpen(false);
    }
  }, [todos.length]);

  if (progress === null) return null;
  const popoverId = `todo-progress-${sessionId}`;
  const completedLabel = `${progress.completed} of ${progress.total} complete`;

  const close = () => {
    setPinned(false);
    setPreviewOpen(false);
    ignoreNextFocusPreview.current = true;
    triggerRef.current?.focus();
  };

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={() => setPreviewOpen(true)}
      onMouseLeave={() => setPreviewOpen(false)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPreviewOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        data-testid="todo-progress-trigger"
        aria-label={`Todo progress, ${completedLabel}, ${STATE_LABEL[progress.state].toLowerCase()}`}
        aria-expanded={open}
        aria-controls={popoverId}
        className={`flex h-[30px] items-center gap-1.5 rounded-sm border px-2 text-[11px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-accent ${STATE_CLASS[progress.state]}`}
        onFocus={() => {
          if (ignoreNextFocusPreview.current) {
            ignoreNextFocusPreview.current = false;
            return;
          }
          setPreviewOpen(true);
        }}
        onClick={() => {
          setPinned((current) => !current);
          setPreviewOpen(false);
        }}
      >
        {progress.state === "running" ? <Loader2 size={13} className="animate-spin" /> : <ListTodo size={13} />}
        <span>{progress.completed}/{progress.total}</span>
        <span className="hidden sm:inline">{STATE_LABEL[progress.state]}</span>
      </button>

      {open && (
        <div
          id={popoverId}
          role="region"
          aria-label="Todo progress details"
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-[min(360px,calc(100vw-24px))] rounded-md border border-border-default bg-bg-elevated p-3 shadow-lg"
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-text-primary">Next steps</div>
              <div aria-live="polite" className="mt-0.5 text-[11px] text-text-muted">
                {completedLabel} · {STATE_LABEL[progress.state]}
              </div>
            </div>
            {pinned && (
              <button type="button" aria-label="Close todo progress" className="text-text-muted hover:text-text-primary" onClick={close}>
                <X size={14} />
              </button>
            )}
          </div>
          <div className="mb-3 h-1 overflow-hidden rounded-full bg-bg-active" aria-hidden="true">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${progress.percent}%` }} />
          </div>
          <div className="max-h-[min(50vh,360px)] space-y-1 overflow-y-auto">
            {todos.map((todo) => <TodoProgressItem key={todo.id} todo={todo} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function TodoProgressItem({ todo }: { todo: SessionTodo }) {
  const presentation = presentTodoContent(todo.content);
  const label = todo.status === "completed"
    ? "Completed"
    : todo.status === "in_progress"
      ? "Current"
      : todo.status === "cancelled"
        ? "Cancelled"
        : "Upcoming";
  return (
    <div
      className="flex items-start gap-2 rounded-sm px-1.5 py-1.5"
      aria-current={todo.status === "in_progress" ? "step" : undefined}
    >
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {todo.status === "completed" ? <Check size={13} className="text-success" /> : todo.status === "in_progress" ? <Loader2 size={13} className="animate-spin text-accent" /> : todo.status === "cancelled" ? <X size={13} className="text-text-muted" /> : <Circle size={11} className="text-text-muted" />}
      </span>
      <span className={`min-w-0 flex-1 text-xs leading-5 ${todo.status === "completed" || todo.status === "cancelled" ? "text-text-muted line-through" : "text-text-secondary"}`}>
        {presentation.content}
      </span>
      {presentation.priority && (
        <span className={`shrink-0 rounded-[3px] px-[5px] py-px text-[10px] font-semibold ${PRIORITY_CLASS[presentation.priority]}`}>
          {PRIORITY_LABEL[presentation.priority]}
        </span>
      )}
      <span className="shrink-0 text-[10px] text-text-muted">{label}</span>
    </div>
  );
}
