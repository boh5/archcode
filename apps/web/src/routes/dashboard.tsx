import { Target, Loader2, CircleDot, RotateCcw } from "lucide-react";
import { useActiveGoals, useActiveLoops, useDashboardHitl } from "../api/queries";
import { HitlInbox } from "../components/features/HitlCard";
import { deriveLoopStatus, formatRunHistoryLabel } from "../lib/loop-status";
import type { DashboardGoal, DashboardLoop, GoalStatus } from "../api/types";

const STATUS_BADGE: Record<GoalStatus, string> = {
  draft: "bg-bg-active text-text-secondary",
  running: "bg-success-muted text-success",
  blocked: "bg-warning-muted text-warning",
  reviewing: "bg-info-muted text-info",
  done: "bg-accent-muted text-accent",
  not_done: "bg-error-muted text-error",
  failed: "bg-error-muted text-error",
  cancelled: "bg-bg-active text-text-tertiary",
};

export function Dashboard() {
  const { data: goals, isLoading: goalsLoading } = useActiveGoals();
  const { data: loops, isLoading: loopsLoading } = useActiveLoops();
  const { data: hitl, isLoading: hitlLoading } = useDashboardHitl();

  const projections = hitl ?? [];

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

        <section data-testid="dashboard-active-loops" className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <RotateCcw size={15} className="text-accent" aria-hidden="true" />
            <h2 className="text-[15px] font-semibold text-text-primary">Active Loops</h2>
            {loops && loops.length > 0 && (
              <span className="bg-accent-muted text-accent px-[7px] py-[1px] rounded-[10px] text-[11px] font-semibold">
                {loops.length}
              </span>
            )}
          </div>

          {loopsLoading ? (
            <div className="flex items-center gap-2 text-[13px] text-text-tertiary py-4">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              Loading active loops…
            </div>
          ) : !loops || loops.length === 0 ? (
            <div className="text-[13px] text-text-tertiary py-4 border border-border-subtle rounded-md px-4 bg-bg-surface">
              No active loops across projects
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {loops.map((loop) => (
                <LoopRow key={`${loop.projectSlug}:${loop.loopId}`} loop={loop} />
              ))}
            </div>
          )}
        </section>

        <div id="approval-queue">
          <HitlInbox
            projections={projections}
            isLoading={hitlLoading}
            hideWhenEmpty
            testId="dashboard-approval-queue"
            className="gap-2.5"
          />
        </div>
      </div>
    </div>
  );
}

function LoopRow({ loop }: { loop: DashboardLoop }) {
  const last = loop.lastRun ? formatRunHistoryLabel(loop.lastRun.status) : "none";
  const next = formatDashboardDate(loop.nextRunAt);
  const status = deriveLoopStatus(loop);

  return (
    <div className="flex items-center gap-3 bg-bg-surface border border-border-default rounded-md px-3.5 py-2.5 hover:border-border-strong transition-colors duration-150">
      <div className="flex flex-col min-w-0 flex-1 gap-0.5">
        <div className="flex items-center gap-2">
          <a
            href={`/projects/${loop.projectSlug}/loops/${loop.loopId}`}
            className="text-[13px] font-medium text-text-primary truncate hover:text-accent transition-colors duration-150"
          >
            {loop.title || "Untitled"}
          </a>
          <span className="text-[11px] text-text-muted shrink-0">{loop.projectName}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            data-testid="dashboard-loop-primary-state"
            className={`text-[10.5px] px-1.5 py-[1px] rounded font-medium ${status.badgeClass}`}
          >
            {status.label}
          </span>
          <span className="text-[10.5px] text-text-tertiary">last: {last}</span>
          <span className="text-[10.5px] text-text-tertiary">next: {next}</span>
        </div>
      </div>
    </div>
  );
}

function formatDashboardDate(value: number | undefined): string {
  if (value === undefined || value === null) return "none";
  return new Date(value).toLocaleString();
}

function GoalRow({ goal }: { goal: DashboardGoal }) {
  return (
    <div className="flex items-center gap-3 bg-bg-surface border border-border-default rounded-md px-3.5 py-2.5 hover:border-border-strong transition-colors duration-150">
      <div className="flex flex-col min-w-0 flex-1 gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-text-primary truncate">{goal.title || "Untitled"}</span>
          <span className="text-[11px] text-text-muted shrink-0">{goal.projectName}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-[10.5px] px-1.5 py-[1px] rounded font-medium ${STATUS_BADGE[goal.status] ?? "bg-bg-active text-text-secondary"}`}>
            {goal.status}
          </span>
          {goal.attempt > 1 && (
            <span className="flex items-center gap-0.5 text-[10.5px] text-text-tertiary">
              <RotateCcw size={10} aria-hidden="true" /> attempt {goal.attempt}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
