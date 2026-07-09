import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { useGoals } from "../api/queries";
import { CreateGoalDialog } from "../components/features/CreateGoalDialog";
import type { GoalState, GoalStatus } from "../api/types";

const STATUS_BADGE_CLASS: Record<GoalStatus, string> = {
  draft: "bg-bg-active text-text-muted",
  running: "bg-success-muted text-success",
  blocked: "bg-warning-muted text-warning",
  reviewing: "bg-info-muted text-info",
  done: "bg-accent-muted text-accent",
  not_done: "bg-error-muted text-error",
  failed: "bg-error-muted text-error",
  cancelled: "bg-bg-active text-text-muted",
};

export function GoalsRoute() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { data: goals, isLoading, error } = useGoals(slug);
  const [createOpen, setCreateOpen] = useState(false);

  const handleCreated = (goalId: string) => {
    setCreateOpen(false);
    navigate(`/projects/${slug}/goals/${goalId}`);
  };

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
      <>
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between px-4 h-12 border-b border-border-subtle shrink-0 bg-bg-surface">
            <span className="font-semibold text-sm text-text-primary">Goals</span>
            <NewGoalButton onClick={() => setCreateOpen(true)} />
          </div>
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <h2 className="text-lg font-medium text-text-primary">No goals yet</h2>
              <p className="text-sm text-text-tertiary text-center max-w-xs">
                Create a draft goal to define what the agent should accomplish and how to verify it.
              </p>
              <NewGoalButton onClick={() => setCreateOpen(true)} variant="primary" />
            </div>
          </div>
        </div>
        <CreateGoalDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          slug={slug}
          onCreated={handleCreated}
        />
      </>
    );
  }

  const handleGoalClick = (goalId: string) => {
    navigate(`/projects/${slug}/goals/${goalId}`);
  };

  return (
    <>
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between px-4 h-12 border-b border-border-subtle shrink-0 bg-bg-surface">
          <span className="font-semibold text-sm text-text-primary">Goals</span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-text-tertiary">{goals.length} total</span>
            <NewGoalButton onClick={() => setCreateOpen(true)} />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto w-full">
            {goals.map((goal) => (
              <GoalListItem key={goal.id} goal={goal} onClick={() => handleGoalClick(goal.id)} />
            ))}
          </div>
        </div>
      </div>
      <CreateGoalDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        slug={slug}
        onCreated={handleCreated}
      />
    </>
  );
}

function NewGoalButton({
  onClick,
  variant = "ghost",
}: {
  onClick: () => void;
  variant?: "ghost" | "primary";
}) {
  if (variant === "primary") {
    return (
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-[12.5px] font-medium text-bg-base transition-colors duration-150 hover:bg-accent-hover"
      >
        <Plus size={13} />
        New Goal
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-sm bg-bg-active px-2.5 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
    >
      <Plus size={13} />
      New Goal
    </button>
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
          {goal.title || "Untitled"}
        </div>
        <div className="flex items-center gap-2 mt-1 text-[11px] text-text-muted">
          <span className="font-mono">{goal.id.slice(0, 8)}</span>
          {goal.attempt > 1 && (
            <span className="text-warning">attempt {goal.attempt}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className={`text-[11px] px-2 py-0.5 rounded-sm font-medium ${STATUS_BADGE_CLASS[goal.status]}`}>
          {goal.status}
        </span>
      </div>
    </div>
  );
}
