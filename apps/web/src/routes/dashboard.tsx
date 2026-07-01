import { Target, Bell, Loader2, CircleDot, RotateCcw } from "lucide-react";
import { useActiveGoals, useHitl } from "../api/queries";
import { HitlCard } from "../components/features/HitlCard";
import type { DashboardGoal, GoalPhase, GoalStatus } from "../api/types";

const STATUS_BADGE: Record<GoalStatus, string> = {
  draft: "bg-bg-active text-text-secondary",
  locked: "bg-warning-muted text-warning",
  running: "bg-success-muted text-success",
  verifying: "bg-info-muted text-info",
  reviewed: "bg-accent-muted text-accent",
  completed: "bg-success-muted text-success",
  failed: "bg-error-muted text-error",
  escalated: "bg-error-muted text-error",
  paused: "bg-bg-active text-text-tertiary",
};

const PHASE_LABEL: Record<GoalPhase, string> = {
  plan: "Plan",
  build: "Build",
  review: "Review",
};

export function Dashboard() {
  const { data: goals, isLoading: goalsLoading } = useActiveGoals();
  const { data: hitl, isLoading: hitlLoading } = useHitl();

  return (
    <div className="h-full overflow-y-auto bg-bg-base">
      <div className="max-w-[1200px] mx-auto px-6 py-6 flex flex-col gap-6">
        <div className="flex items-center gap-2.5">
          <Target size={22} className="text-accent" aria-hidden="true" />
          <h1 className="text-xl font-semibold text-text-primary">Dashboard</h1>
        </div>

        <section data-testid="dashboard-active-goals" className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <CircleDot size={15} className="text-success" aria-hidden="true" />
            <h2 className="text-[15px] font-semibold text-text-primary">Active Goals</h2>
            {goals && goals.length > 0 && (
              <span className="bg-success-muted text-success px-[7px] py-[1px] rounded-[10px] text-[11px] font-semibold">
                {goals.length}
              </span>
            )}
          </div>

          {goalsLoading ? (
            <div className="flex items-center gap-2 text-[13px] text-text-tertiary py-4">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              Loading active goals…
            </div>
          ) : !goals || goals.length === 0 ? (
            <div className="text-[13px] text-text-tertiary py-4 border border-border-subtle rounded-md px-4 bg-bg-surface">
              No active goals across projects
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {goals.map((goal) => (
                <GoalRow key={goal.id} goal={goal} />
              ))}
            </div>
          )}
        </section>

        <section data-testid="dashboard-approval-queue" className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <Bell size={15} className="text-warning" aria-hidden="true" />
            <h2 className="text-[15px] font-semibold text-text-primary">Approval Queue</h2>
            {hitl && hitl.length > 0 && (
              <span className="bg-warning-muted text-warning px-[7px] py-[1px] rounded-[10px] text-[11px] font-semibold">
                {hitl.length}
              </span>
            )}
          </div>

          {hitlLoading ? (
            <div className="flex items-center gap-2 text-[13px] text-text-tertiary py-4">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              Loading approval queue…
            </div>
          ) : !hitl || hitl.length === 0 ? (
            <div className="text-[13px] text-text-tertiary py-4 border border-border-subtle rounded-md px-4 bg-bg-surface">
              No pending approvals
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {hitl.map((item) => (
                <HitlCard key={item.hitlId} item={item} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function GoalRow({ goal }: { goal: DashboardGoal }) {
  return (
    <div className="flex items-center gap-3 bg-bg-surface border border-border-default rounded-md px-3.5 py-2.5 hover:border-border-strong transition-colors duration-150">
      <div className="flex flex-col min-w-0 flex-1 gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-text-primary truncate">{goal.title}</span>
          <span className="text-[11px] text-text-muted shrink-0">{goal.projectName}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-[10.5px] px-1.5 py-[1px] rounded font-medium ${STATUS_BADGE[goal.status] ?? "bg-bg-active text-text-secondary"}`}>
            {goal.status}
          </span>
          <span className="text-[10.5px] text-text-tertiary">{PHASE_LABEL[goal.phase] ?? goal.phase}</span>
          {goal.retryCount > 0 && (
            <span className="flex items-center gap-0.5 text-[10.5px] text-text-tertiary">
              <RotateCcw size={10} aria-hidden="true" /> retry {goal.retryCount}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}