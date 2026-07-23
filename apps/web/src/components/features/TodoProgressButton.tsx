import { useEffect, useRef, useState } from "react";
import { Check, Circle, CircleDot, X } from "lucide-react";
import type { SessionTodo } from "@archcode/protocol";
import { useSessionStore } from "../../store/session-store";
import { deriveTodoProgress, presentTodoContent, type TodoPriority, type TodoProgressState } from "../../lib/todo-progress";
import { ProgressRing } from "../primitives/ProgressRing";
import { IconAction } from "../primitives/IconAction";
import { STATUS_SUBTLE_CLASS, STATUS_TONE_CLASS, type StatusTone } from "../../lib/status-visuals";

const HOVER_OPEN_DELAY_MS = 100;
const HOVER_CLOSE_DELAY_MS = 180;

const STATE_LABEL: Record<TodoProgressState, string> = {
  running: "Running",
  waiting: "Waiting",
  blocked: "Blocked",
  failed: "Failed",
  completed: "Completed",
  idle: "Ready",
};

const STATE_TONE: Record<TodoProgressState, StatusTone> = {
  running: "info",
  waiting: "warning",
  blocked: "warning",
  failed: "error",
  completed: "success",
  idle: "neutral",
};

const PRIORITY_LABEL: Record<TodoPriority, string> = {
  high: "P0",
  medium: "P1",
  low: "P2",
};

const PRIORITY_CLASS: Record<TodoPriority, string> = {
  high: "bg-error-muted text-error",
  medium: "bg-warning-muted text-warning",
  low: "bg-bg-active text-text-tertiary",
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
    blockedByHitlIds: Array.isArray(blockedByHitlIds) ? blockedByHitlIds.filter((id): id is string => typeof id === "string") : undefined,
  });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const ignoreNextFocusPreview = useRef(false);
  const hoverOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectingInPreview = useRef(false);
  const open = previewOpen || pinned;

  const clearHoverOpenTimer = () => {
    if (hoverOpenTimer.current === null) return;
    clearTimeout(hoverOpenTimer.current);
    hoverOpenTimer.current = null;
  };

  const clearHoverCloseTimer = () => {
    if (hoverCloseTimer.current === null) return;
    clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = null;
  };

  const keepPreviewOpen = () => {
    clearHoverCloseTimer();
    if (!pinned) setPreviewOpen(true);
  };

  const schedulePreviewOpen = () => {
    clearHoverCloseTimer();
    clearHoverOpenTimer();
    if (pinned) return;
    hoverOpenTimer.current = setTimeout(() => {
      hoverOpenTimer.current = null;
      setPreviewOpen(true);
    }, HOVER_OPEN_DELAY_MS);
  };

  const schedulePreviewClose = () => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    if (pinned || selectingInPreview.current) return;
    hoverCloseTimer.current = setTimeout(() => {
      hoverCloseTimer.current = null;
      setPreviewOpen(false);
    }, HOVER_CLOSE_DELAY_MS);
  };

  const resetOpenState = () => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    selectingInPreview.current = false;
    setPinned(false);
    setPreviewOpen(false);
  };

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
    resetOpenState();
  }, [sessionId]);

  useEffect(() => {
    if (todos.length === 0) resetOpenState();
  }, [todos.length]);

  useEffect(() => {
    const finishSelection = (event: MouseEvent) => {
      if (!selectingInPreview.current) return;
      selectingInPreview.current = false;
      if (!containerRef.current?.contains(event.target as Node)) schedulePreviewClose();
    };
    document.addEventListener("mouseup", finishSelection);
    return () => document.removeEventListener("mouseup", finishSelection);
  });

  useEffect(() => () => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
  }, []);

  if (progress === null) return null;
  const popoverId = `todo-progress-${sessionId}`;
  const completedLabel = `${progress.completed} of ${progress.total} complete`;
  const tone = STATE_TONE[progress.state];

  const close = () => {
    resetOpenState();
    ignoreNextFocusPreview.current = true;
    triggerRef.current?.focus();
  };

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={schedulePreviewOpen}
      onMouseLeave={schedulePreviewClose}
      onFocusCapture={keepPreviewOpen}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) schedulePreviewClose();
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
        className={`flex h-8 items-center gap-2 rounded-sm border border-border-default px-2 text-[11px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-brand ${STATUS_SUBTLE_CLASS[tone]} ${STATUS_TONE_CLASS[tone]}`}
        onFocus={() => {
          if (ignoreNextFocusPreview.current) {
            ignoreNextFocusPreview.current = false;
            return;
          }
          setPreviewOpen(true);
        }}
        onClick={() => {
          clearHoverOpenTimer();
          clearHoverCloseTimer();
          setPinned((current) => !current);
          setPreviewOpen(false);
        }}
      >
        <ProgressRing percent={progress.percent} tone={tone} />
        <span>{progress.completed}/{progress.total}</span>
        <span className="hidden sm:inline">Todos</span>
      </button>

      {open && (
        <div
          data-testid="todo-progress-hover-layer"
          className="fixed left-3 right-3 top-[100px] z-50 w-auto sm:absolute sm:left-auto sm:right-0 sm:top-full sm:w-[360px] sm:pt-2"
          onMouseEnter={keepPreviewOpen}
          onMouseLeave={schedulePreviewClose}
          onMouseDown={() => {
            selectingInPreview.current = true;
            clearHoverCloseTimer();
          }}
        >
          <div
            id={popoverId}
            role="region"
            aria-label="Todo progress details"
            className="select-text rounded-lg border border-border-default bg-bg-overlay p-3 shadow-md"
          >
            <div className="mb-2 flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-text-primary">Next steps</div>
                <div aria-live="polite" className="mt-1 text-[11px] text-text-tertiary">
                  {completedLabel} · {STATE_LABEL[progress.state]}
                </div>
              </div>
              {pinned && (
                <IconAction label="Close todo progress" onClick={close}>
                  <X aria-hidden="true" size={14} />
                </IconAction>
              )}
            </div>
            <div className="mb-3 h-1 overflow-hidden rounded-full bg-bg-active" aria-hidden="true">
              <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${progress.percent}%` }} />
            </div>
            <div className="max-h-[min(50vh,360px)] space-y-1 overflow-y-auto">
              {todos.map((todo) => <TodoProgressItem key={todo.id} todo={todo} />)}
            </div>
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
      className="flex items-start gap-2 rounded-sm px-2 py-2"
      aria-current={todo.status === "in_progress" ? "step" : undefined}
    >
      <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center">
        {todo.status === "completed" ? <Check size={13} className="text-success" /> : todo.status === "in_progress" ? <CircleDot size={13} className="text-info" /> : todo.status === "cancelled" ? <X size={13} className="text-neutral" /> : <Circle size={11} className="text-neutral" />}
      </span>
      <span className={`min-w-0 flex-1 text-xs leading-5 ${todo.status === "completed" || todo.status === "cancelled" ? "text-text-tertiary line-through" : "text-text-secondary"}`}>
        {presentation.content}
      </span>
      {presentation.priority && (
        <span className={`shrink-0 rounded-sm px-1 py-px text-[11px] font-semibold ${PRIORITY_CLASS[presentation.priority]}`}>
          {PRIORITY_LABEL[presentation.priority]}
        </span>
      )}
      <span className={`shrink-0 text-[11px] ${todo.status === "in_progress" ? "text-info" : todo.status === "completed" ? "text-success" : todo.status === "cancelled" ? "text-neutral" : "text-text-tertiary"}`}>{label}</span>
    </div>
  );
}
