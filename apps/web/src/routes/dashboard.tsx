import { Target, Loader2, CircleDot, RotateCcw } from "lucide-react";
import { Link } from "react-router-dom";
import { useActiveAutomations, useProjects, useSessionGoals } from "../api/queries";
import { useRealtimeHitlEntries } from "../store/hitl-store";
import { HitlInbox } from "../components/features/HitlCard";
import type { DashboardAutomation, DashboardSessionGoal, SessionGoalStatus } from "../api/types";

const STATUS_BADGE: Record<SessionGoalStatus, string> = {
  active: "bg-success-muted text-success",
  paused: "bg-warning-muted text-warning",
  blocked: "bg-error-muted text-error",
  budget_limited: "bg-warning-muted text-warning",
  complete: "bg-accent-muted text-accent",
};

export function Dashboard() {
  const { data: sessionGoals, isLoading: goalsLoading } = useSessionGoals();
  const { data: automations, isLoading: automationsLoading } = useActiveAutomations();
  const { data: projects, isLoading: projectsLoading } = useProjects();
  const entries = useRealtimeHitlEntries((projects ?? []).map((project) => project.slug));

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
            <h2 className="text-[15px] font-semibold text-text-primary">Session Goals</h2>
            {sessionGoals && sessionGoals.length > 0 && (
              <span className="bg-success-muted text-success px-[7px] py-[1px] rounded-[10px] text-[11px] font-semibold">
                {sessionGoals.length}
              </span>
            )}
          </div>

          {goalsLoading ? (
            <div className="flex items-center gap-2 text-[13px] text-text-tertiary py-4">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              Loading session goals…
            </div>
          ) : !sessionGoals || sessionGoals.length === 0 ? (
            <div className="text-[13px] text-text-tertiary py-4 border border-border-subtle rounded-md px-4 bg-bg-surface">
              No session goals across projects
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {sessionGoals.map((sessionGoal) => (
                <SessionGoalRow key={`${sessionGoal.projectSlug}:${sessionGoal.sessionId}`} sessionGoal={sessionGoal} />
              ))}
            </div>
          )}
        </section>

        <section data-testid="dashboard-active-automations" className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <RotateCcw size={15} className="text-accent" aria-hidden="true" />
            <h2 className="text-[15px] font-semibold text-text-primary">Active Automations</h2>
            {automations && automations.length > 0 && (
              <span className="bg-accent-muted text-accent px-[7px] py-[1px] rounded-[10px] text-[11px] font-semibold">
                {automations.length}
              </span>
            )}
          </div>

          {automationsLoading ? (
            <div className="flex items-center gap-2 text-[13px] text-text-tertiary py-4">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              Loading active automations…
            </div>
          ) : !automations || automations.length === 0 ? (
            <div className="text-[13px] text-text-tertiary py-4 border border-border-subtle rounded-md px-4 bg-bg-surface">
              No active automations across projects
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {automations.map((automation) => (
                <AutomationRow key={`${automation.projectSlug}:${automation.id}`} automation={automation} />
              ))}
            </div>
          )}
        </section>

        <div id="approval-queue">
          <HitlInbox
            entries={entries}
            isLoading={projectsLoading}
            hideWhenEmpty
            testId="dashboard-approval-queue"
            className="gap-2.5"
          />
        </div>
      </div>
    </div>
  );
}

function AutomationRow({ automation }: { automation: DashboardAutomation }) {
  const next = formatDashboardDate(automation.nextFireAt);

  return (
    <div className="flex items-center gap-3 bg-bg-surface border border-border-default rounded-md px-3.5 py-2.5 hover:border-border-strong transition-colors duration-150">
      <div className="flex flex-col min-w-0 flex-1 gap-0.5">
        <div className="flex items-center gap-2">
          <a
            href={`/projects/${automation.projectSlug}/automations/${automation.id}`}
            className="text-[13px] font-medium text-text-primary truncate hover:text-accent transition-colors duration-150"
          >
            {automation.name}
          </a>
          <span className="text-[11px] text-text-muted shrink-0">{automation.projectName}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            data-testid="dashboard-automation-primary-state"
            className="text-[10.5px] px-1.5 py-[1px] rounded font-medium bg-accent-muted text-accent"
          >
            {automation.status}
          </span>
          <span className="text-[10.5px] text-text-tertiary">next: {next}</span>
        </div>
      </div>
    </div>
  );
}

function formatDashboardDate(value: string | undefined): string {
  if (value === undefined || value === null) return "none";
  return new Date(value).toLocaleString();
}

function SessionGoalRow({ sessionGoal }: { sessionGoal: DashboardSessionGoal }) {
  const { goal } = sessionGoal;
  return (
    <div className="flex items-center gap-3 bg-bg-surface border border-border-default rounded-md px-3.5 py-2.5 hover:border-border-strong transition-colors duration-150">
      <div className="flex flex-col min-w-0 flex-1 gap-0.5">
        <div className="flex items-center gap-2">
          <Link
            to={`/projects/${sessionGoal.projectSlug}/sessions/${sessionGoal.sessionId}`}
            className="text-[13px] font-medium text-text-primary truncate hover:text-accent"
          >
            {goal.objective}
          </Link>
          <span className="text-[11px] text-text-muted shrink-0">{sessionGoal.projectName}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-[10.5px] px-1.5 py-[1px] rounded font-medium ${STATUS_BADGE[goal.status]}`}>
            {goal.status}
          </span>
          {goal.tokensUsed !== undefined && <span className="text-[10.5px] text-text-tertiary">{goal.tokensUsed.toLocaleString()} tokens</span>}
          {goal.timeUsedSeconds !== undefined && <span className="text-[10.5px] text-text-tertiary">{formatSeconds(goal.timeUsedSeconds)}</span>}
          {goal.latestReason && <span className="min-w-0 truncate text-[10.5px] text-text-tertiary">{goal.latestReason}</span>}
        </div>
      </div>
    </div>
  );
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m`;
}
