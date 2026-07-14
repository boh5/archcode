import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, GitBranch, RotateCcw, XCircle } from "lucide-react";
import { useGoal, useSession } from "../api/queries";
import { useRetryGoal, useCancelGoal } from "../api/mutations";
import { HitlInbox } from "../components/features/HitlCard";
import { useRealtimeHitl } from "../store/hitl-store";
import { useWorkbenchLayout } from "../context/workbench-layout";
import { InspectorToggleButton } from "../components/features/InspectorToggleButton";
import { getGoalStatusBadgeClass } from "../lib/goal-status";

export function GoalDetailRoute() {
  const { slug = "", goalId = "" } = useParams<{ slug: string; goalId: string }>();
  const navigate = useNavigate();
  const { data: goal, isLoading, error } = useGoal(slug, goalId);
  const retryGoal = useRetryGoal();
  const cancelGoal = useCancelGoal();
  const layout = useWorkbenchLayout();
  const { toggleInspectorSurface } = layout;
  const goalHitl = useRealtimeHitl({
    slug,
    scope: "goal",
    ownerId: goalId,
    includeChildren: true,
  });
  const sourceSessionId = goal?.createdFromSessionId ?? "";
  const sourceSession = useSession(slug, sourceSessionId);
  const mutationError = retryGoal.error ?? cancelGoal.error;

  const handleBack = () => {
    navigate(`/projects/${slug}/goals`);
  };

  const handleRetry = () => {
    retryGoal.mutate({ slug, goalId });
  };

  const handleCancel = () => {
    cancelGoal.mutate({ slug, goalId });
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-text-secondary text-sm gap-2">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-text-muted border-t-transparent" />
        Loading goal...
      </div>
    );
  }

  if (error || !goal) {
    const message = error instanceof Error ? error.message : "Goal not found";
    return (
      <div className="flex h-full flex-col">
        <BackBar onBack={handleBack} />
        <div className="flex-1 flex items-center justify-center text-error text-sm">
          {message}
        </div>
      </div>
    );
  }

  const canRetry = goal.status === "not_done" || goal.status === "failed";
  const canCancel = goal.status === "running" || goal.status === "reviewing" || goal.status === "not_done" || goal.status === "failed";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-4 h-12 border-b border-border-subtle shrink-0 bg-bg-surface">
        <button
          className="flex items-center gap-1 text-text-tertiary hover:text-text-primary transition-colors duration-150 cursor-pointer text-[12.5px]"
          onClick={handleBack}
        >
          <ArrowLeft size={14} />
          Goals
        </button>
        <span className="text-text-muted">/</span>
        <span className="font-semibold text-sm text-text-primary truncate">{goal.title || "Untitled"}</span>
        <div className="flex items-center gap-2 ml-auto">
          {canRetry && (
            <button
              type="button"
              onClick={handleRetry}
              disabled={retryGoal.isPending}
              aria-label="Retry goal"
              title="Retry goal"
              className="inline-flex items-center gap-1.5 rounded-sm bg-bg-active px-3 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RotateCcw size={13} />
              <span className="max-[900px]:hidden">{retryGoal.isPending ? "Retrying…" : "Retry Goal"}</span>
            </button>
          )}
          {canCancel && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelGoal.isPending}
              aria-label="Cancel goal"
              title="Cancel goal"
              className="inline-flex items-center gap-1.5 rounded-sm bg-bg-active px-3 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <XCircle size={13} />
              <span className="max-[900px]:hidden">{cancelGoal.isPending ? "Cancelling…" : "Cancel Goal"}</span>
            </button>
          )}
          <span className={`text-[11px] px-2 py-0.5 rounded-sm font-medium ${getGoalStatusBadgeClass(goal.status)}`}>
            {goal.status}
          </span>
          <InspectorToggleButton expanded={layout.inspectorExpanded} onToggle={toggleInspectorSurface} />
        </div>
      </div>

      {mutationError && (
        <div className="border-b border-border-subtle bg-error-muted px-4 py-2 text-xs text-error" role="alert">
          {mutationError.message}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <div data-testid="goal-approval-queue">
            <HitlInbox
              projections={goalHitl}
              emptyMessage="No pending approvals for this goal"
              title="Goal approvals"
              className="gap-2"
            />
          </div>
          <Link
            to={`/projects/${slug}/sessions/${goal.mainSessionId}`}
            className="flex items-center gap-3 rounded-md border border-border-default bg-bg-surface p-4 transition-colors hover:bg-bg-hover"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-subtle text-accent"><GitBranch size={17} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-text-primary">Open execution session</span>
              <span className="block truncate font-mono text-[11px] text-text-muted">{goal.mainSessionId}</span>
            </span>
            <span className="text-xs text-text-tertiary">Open →</span>
          </Link>
          <section className="rounded-md border border-border-default bg-bg-surface p-4">
            <h2 className="font-semibold">Created from</h2>
            {sourceSessionId && sourceSession.isLoading ? (
              <p className="mt-2 text-sm text-text-tertiary">Loading…</p>
            ) : sourceSessionId && sourceSession.data ? (
              <Link className="mt-2 block text-sm text-accent hover:underline" to={`/projects/${slug}/sessions/${sourceSessionId}`}>
                {sourceSession.data.title || sourceSessionId}
              </Link>
            ) : (
              <p className="mt-2 text-sm text-text-tertiary">Unavailable</p>
            )}
          </section>
          {goal.lastFailureSummary && (
            <div className="rounded-md border border-warning/30 bg-warning-muted p-4 text-xs leading-5 text-warning">
              {goal.lastFailureSummary}
            </div>
          )}
          {goal.lastError && (
            <div className="rounded-md border border-error/30 bg-error-muted p-4 text-xs leading-5 text-error">
              {goal.lastError.name}: {goal.lastError.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BackBar({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex items-center gap-3 px-4 h-12 border-b border-border-subtle shrink-0 bg-bg-surface">
      <button
        className="flex items-center gap-1 text-text-tertiary hover:text-text-primary transition-colors duration-150 cursor-pointer text-[12.5px]"
        onClick={onBack}
      >
        <ArrowLeft size={14} />
        Goals
      </button>
    </div>
  );
}
