import { useState } from "react";
import { useParams } from "react-router-dom";
import { ArrowLeft, Play, RotateCcw, XCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useGoal } from "../api/queries";
import { useRunGoal, useRetryGoal, useCancelGoal } from "../api/mutations";
import type { GoalStatus } from "../api/types";
import { GoalOverview } from "../components/features/GoalOverview";
import { GoalSessions } from "../components/features/GoalSessions";
import { GoalChat } from "../components/features/GoalChat";

type Tab = "overview" | "chat" | "sessions";

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

const TABS: { id: Tab; label: string; testId: string }[] = [
  { id: "overview", label: "Overview", testId: "goal-overview-tab" },
  { id: "chat", label: "Chat", testId: "goal-chat-tab" },
  { id: "sessions", label: "Sessions", testId: "goal-sessions-tab" },
];

export function GoalDetailRoute() {
  const { slug = "", goalId = "" } = useParams<{ slug: string; goalId: string }>();
  const navigate = useNavigate();
  const { data: goal, isLoading, error } = useGoal(slug, goalId);
  const runGoal = useRunGoal();
  const retryGoal = useRetryGoal();
  const cancelGoal = useCancelGoal();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const mutationError = runGoal.error ?? retryGoal.error ?? cancelGoal.error;

  const handleBack = () => {
    navigate(`/projects/${slug}/goals`);
  };

  const handleRun = () => {
    runGoal.mutate({ slug, goalId });
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

  const canRun = goal.status === "draft";
  const canRetry = goal.status === "not_done" || goal.status === "failed";
  const canCancel = goal.status === "draft" || goal.status === "running" || goal.status === "blocked" || goal.status === "reviewing" || goal.status === "not_done" || goal.status === "failed";

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
        <span className="font-semibold text-sm text-text-primary truncate">{goal.title}</span>
        <div className="flex items-center gap-2 ml-auto">
          {canRun && (
            <button
              type="button"
              onClick={handleRun}
              disabled={runGoal.isPending}
              className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-[12.5px] font-medium text-bg-base transition-colors duration-150 hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Play size={13} />
              {runGoal.isPending ? "Starting…" : "Run Goal"}
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              onClick={handleRetry}
              disabled={retryGoal.isPending}
              className="inline-flex items-center gap-1.5 rounded-sm bg-bg-active px-3 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RotateCcw size={13} />
              {retryGoal.isPending ? "Retrying…" : "Retry Goal"}
            </button>
          )}
          {canCancel && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelGoal.isPending}
              className="inline-flex items-center gap-1.5 rounded-sm bg-bg-active px-3 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <XCircle size={13} />
              {cancelGoal.isPending ? "Cancelling…" : "Cancel Goal"}
            </button>
          )}
          <span className={`text-[11px] px-2 py-0.5 rounded-sm font-medium ${STATUS_BADGE_CLASS[goal.status]}`}>
            {goal.status}
          </span>
        </div>
      </div>

      {mutationError && (
        <div className="border-b border-border-subtle bg-error-muted px-4 py-2 text-xs text-error" role="alert">
          {mutationError.message}
        </div>
      )}

      <div className="flex items-center gap-1 px-4 border-b border-border-subtle shrink-0 bg-bg-surface" role="tablist" aria-label="Goal detail sections">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            id={`goal-tab-${tab.id}`}
            data-testid={tab.testId}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`goal-panel-${tab.id}`}
            className={`px-3 py-2 text-[12.5px] font-medium transition-colors duration-150 cursor-pointer border-b-2 ${
              activeTab === tab.id
                ? "text-text-primary border-accent"
                : "text-text-tertiary border-transparent hover:text-text-secondary"
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        <section id={`goal-panel-${activeTab}`} role="tabpanel" aria-labelledby={`goal-tab-${activeTab}`}>
          {activeTab === "overview" && <GoalOverview goal={goal} slug={slug} />}
          {activeTab === "chat" && <GoalChat slug={slug} goal={goal} />}
          {activeTab === "sessions" && <GoalSessions slug={slug} goal={goal} />}
        </section>
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