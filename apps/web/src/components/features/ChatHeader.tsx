import { CircleX, Menu } from "lucide-react";
import { usePostCommand } from "../../api/mutations";
import { useGoal } from "../../api/queries";
import { useSessionStore } from "../../store/session-store";
import type { GoalStatus } from "../../api/types";

const STATUS_BADGE_CLASS: Record<GoalStatus, string> = {
  draft: "bg-bg-active text-text-muted",
  locked: "bg-info-muted text-info",
  running: "bg-success-muted text-success",
  verifying: "bg-warning-muted text-warning",
  reviewed: "bg-accent-muted text-accent",
  completed: "bg-accent-muted text-accent",
  failed: "bg-error-muted text-error",
  escalated: "bg-error-muted text-error",
  paused: "bg-warning-muted text-warning",
};

interface ChatHeaderProps {
  slug: string;
  sessionId: string;
  goalId?: string;
  onToggleDetail: () => void;
}

export function ChatHeader({ slug, sessionId, goalId, onToggleDetail }: ChatHeaderProps) {
  const title = useSessionStore(sessionId, (s) => s.title, slug);
  const stats = useSessionStore(sessionId, (s) => s.stats, slug);
  const postCommand = usePostCommand();
  const { data: goal } = useGoal(slug, goalId ?? "");

  const handleCompact = () => {
    postCommand.mutate({ slug, sessionId, name: "compact" });
  };

  const hasStats = stats && (stats.messages.total > 0 || stats.tools.calls > 0 || stats.usage.totalTokens > 0);

  return (
    <div className="flex items-center justify-between px-4 h-12 border-b border-border-subtle shrink-0 bg-bg-surface">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="font-semibold text-sm text-text-primary truncate">{title ?? "Untitled"}</span>
        {goal && (
          <span
            data-testid="goal-phase"
            className="text-[11px] px-2 py-0.5 rounded-sm font-medium whitespace-nowrap flex items-center gap-1.5"
          >
            <span className={`px-1.5 py-0.5 rounded-sm ${STATUS_BADGE_CLASS[goal.status]}`}>
              {goal.status}
            </span>
            <span className="text-text-tertiary uppercase tracking-wider">{goal.phase}</span>
          </span>
        )}
        {hasStats && (
          <span className="text-xs text-text-tertiary whitespace-nowrap">
            · Messages: {stats.messages.total} · Tools: {stats.tools.calls} · Tokens: {stats.usage.totalTokens.toLocaleString()}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <button
          className="w-[30px] h-[30px] rounded-sm border border-border-default bg-transparent text-text-tertiary cursor-pointer flex items-center justify-center transition-all duration-150 hover:bg-bg-hover hover:text-text-primary hover:border-border-strong"
          title="Compact context"
          onClick={handleCompact}
          disabled={postCommand.isPending}
        >
          <CircleX size={16} />
        </button>
        <button
          className="w-[30px] h-[30px] rounded-sm border border-border-default bg-transparent text-text-tertiary cursor-pointer flex items-center justify-center transition-all duration-150 hover:bg-bg-hover hover:text-text-primary hover:border-border-strong"
          title="Toggle detail panel"
          onClick={onToggleDetail}
        >
          <Menu size={16} />
        </button>
      </div>
    </div>
  );
}