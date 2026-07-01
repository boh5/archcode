import { useNavigate, useParams } from "react-router-dom";
import { useGoals } from "../api/queries";
import type { GoalState, GoalStatus } from "../api/types";

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

export function GoalsRoute() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { data: goals, isLoading, error } = useGoals(slug);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-text-secondary text-sm gap-2">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-text-muted border-t-transparent" />
        Loading goals...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-error text-sm">
        Failed to load goals
      </div>
    );
  }

  if (!goals || goals.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-lg font-medium text-text-primary">No goals yet</h2>
          <p className="text-sm text-text-tertiary">
            Goals created by the orchestrator will appear here
          </p>
        </div>
      </div>
    );
  }

  const handleGoalClick = (goalId: string) => {
    navigate(`/projects/${slug}/goals/${goalId}`);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 h-12 border-b border-border-subtle shrink-0 bg-bg-surface">
        <span className="font-semibold text-sm text-text-primary">Goals</span>
        <span className="text-xs text-text-tertiary">{goals.length} total</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto w-full">
          {goals.map((goal) => (
            <GoalListItem key={goal.id} goal={goal} onClick={() => handleGoalClick(goal.id)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function GoalListItem({ goal, onClick }: { goal: GoalState; onClick: () => void }) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle cursor-pointer transition-colors duration-150 hover:bg-bg-hover"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-text-primary truncate">
          {goal.title}
        </div>
        <div className="flex items-center gap-2 mt-1 text-[11px] text-text-muted">
          <span className="font-mono">{goal.id.slice(0, 8)}</span>
          {goal.retryCount > 0 && (
            <span className="text-warning">retry {goal.retryCount}/{goal.retryPolicy.maxRetries}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[11px] text-text-tertiary capitalize">{goal.phase}</span>
        <span className={`text-[11px] px-2 py-0.5 rounded-sm font-medium ${STATUS_BADGE_CLASS[goal.status]}`}>
          {goal.status}
        </span>
      </div>
    </div>
  );
}