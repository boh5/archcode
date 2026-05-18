import type { StoredTodo, StoredTodoStatus } from "../../../../store/types";
import { useSessionStore } from "../../store/session-store";

// ─── Priority extraction from content ───

type Priority = "high" | "medium" | "low";

const PRIORITY_PATTERN = /\b(P0|P1|P2)\b/i;

function extractPriority(content: string): Priority | null {
  const match = PRIORITY_PATTERN.exec(content);
  if (!match) return null;
  const tag = match[1].toUpperCase();
  if (tag === "P0") return "high";
  if (tag === "P1") return "medium";
  return "low";
}

const PRIORITY_LABELS: Record<Priority, string> = {
  high: "P0",
  medium: "P1",
  low: "P2",
};

const PRIORITY_CLASSES: Record<Priority, string> = {
  high: "bg-error-muted text-error",
  medium: "bg-warning-muted text-warning",
  low: "bg-bg-active text-text-muted",
};

// ─── Status icon ───

const STATUS_CLASSES: Record<StoredTodoStatus, string> = {
  completed: "bg-success text-white",
  in_progress: "border-2 border-accent text-accent",
  pending: "border-[1.5px] border-border-strong",
  cancelled: "border-[1.5px] border-border-strong opacity-40",
};

const STATUS_ICON: Record<StoredTodoStatus, string> = {
  completed: "✓",
  in_progress: "",
  pending: "",
  cancelled: "✕",
};

const TEXT_CLASSES: Record<StoredTodoStatus, string> = {
  completed: "line-through text-text-muted",
  in_progress: "text-text-primary font-medium",
  pending: "text-text-secondary",
  cancelled: "line-through text-text-muted opacity-50",
};

// ─── TodoItem ───

function TodoItem({ todo }: { todo: StoredTodo }) {
  const priority = extractPriority(todo.content);
  const displayContent = priority
    ? todo.content.replace(PRIORITY_PATTERN, "").replace(/\s{2,}/g, " ").trim()
    : todo.content;

  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-border-subtle last:border-b-0">
      <div
        className={`w-4 h-4 rounded-full shrink-0 flex items-center justify-center text-[9px] mt-0.5 ${STATUS_CLASSES[todo.status]}`}
      >
        {todo.status === "in_progress" ? (
          <span className="w-[5px] h-[5px] rounded-full bg-accent animate-pulse" />
        ) : (
          STATUS_ICON[todo.status]
        )}
      </div>
      <span className={`flex-1 text-[12.5px] leading-[1.4] min-w-0 ${TEXT_CLASSES[todo.status]}`}>
        {displayContent}
      </span>
      {priority && (
        <span
          className={`text-[10px] px-[5px] py-px rounded-[3px] shrink-0 font-semibold ${PRIORITY_CLASSES[priority]}`}
        >
          {PRIORITY_LABELS[priority]}
        </span>
      )}
    </div>
  );
}

// ─── TodoTab (export) ───

export interface TodoTabProps {
  sessionId: string;
}

export function TodoTab({ sessionId }: TodoTabProps) {
  const todos = useSessionStore(sessionId, (s) => s.todos);

  if (todos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-muted text-[12.5px] py-12">
        <span className="text-lg mb-1.5">📋</span>
        No tasks yet
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto p-4">
      {todos.map((todo) => (
        <TodoItem key={todo.id} todo={todo} />
      ))}
    </div>
  );
}