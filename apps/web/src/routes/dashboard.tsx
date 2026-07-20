import { AlertCircle, CircleDot, Clock3, Loader2, Play, Target } from "lucide-react";
import { Link } from "react-router-dom";
import type { DashboardScope, SessionGoalStatus } from "@archcode/protocol";
import { useDashboardProjection } from "../hooks/use-dashboard-projection";
import type {
  DashboardAttentionItem,
  DashboardAutomationRow,
  DashboardSessionRow,
} from "../lib/dashboard-projection";
import { formatRelativeTime } from "../lib/time-format";

const HOME_SCOPE: DashboardScope = { kind: "global" };

const GOAL_STATUS_CLASS: Record<SessionGoalStatus, string> = {
  active: "bg-success-muted text-success",
  paused: "bg-warning-muted text-warning",
  blocked: "bg-error-muted text-error",
  budget_limited: "bg-warning-muted text-warning",
  complete: "bg-accent-muted text-accent",
};

export function Dashboard({ scope = HOME_SCOPE }: { scope?: DashboardScope }) {
  const { data, sections, isLoading, error } = useDashboardProjection(scope);
  const isGlobal = scope.kind === "global";

  return (
    <main className="h-full overflow-y-auto bg-bg-base" data-testid={`dashboard-${scope.kind}`}>
      <div className="mx-auto flex max-w-[1200px] flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6">
        <header className="flex items-center gap-2.5">
          <Target size={22} className="text-accent" aria-hidden="true" />
          <h1 className="text-xl font-semibold text-text-primary">Dashboard</h1>
        </header>

        {error ? <DashboardLoadError scope={scope} /> : null}
        {data?.errors.map((projectError) => (
          <div
            key={projectError.projectSlug}
            role="alert"
            className="rounded-md border border-error/40 bg-error-muted px-3.5 py-3 text-sm text-error"
          >
            Couldn’t load dashboard data for {projectError.projectName}: {projectError.message}
          </div>
        ))}

        {isLoading ? (
          <div className="flex items-center gap-2 py-5 text-[13px] text-text-tertiary">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            Loading dashboard…
          </div>
        ) : null}

        <DashboardSection
          id="needs-attention"
          icon={<AlertCircle size={16} className="text-warning" aria-hidden="true" />}
          title="Needs attention"
          count={sections.attention.length}
          emptyMessage="Nothing needs your attention."
        >
          {sections.attention.map((item) => <AttentionRow key={item.identity} item={item} showProject={isGlobal} />)}
        </DashboardSection>

        <DashboardSection
          icon={<Play size={16} className="text-success" aria-hidden="true" />}
          title="Running now"
          count={sections.running.length}
          emptyMessage="No sessions are running."
        >
          {sections.running.map((item) => <SessionRow key={item.identity} item={item} showProject={isGlobal} />)}
        </DashboardSection>

        <DashboardSection
          icon={<CircleDot size={16} className="text-accent" aria-hidden="true" />}
          title="Continue working"
          count={sections.continueWorking.length}
          emptyMessage="No recent sessions to continue."
        >
          {sections.continueWorking.map((item) => <SessionRow key={item.identity} item={item} showProject={isGlobal} />)}
        </DashboardSection>

        <DashboardSection
          icon={<Clock3 size={16} className="text-text-secondary" aria-hidden="true" />}
          title="Upcoming"
          count={sections.upcoming.length}
          emptyMessage="No scheduled automations."
        >
          {sections.upcoming.map((item) => <AutomationRow key={item.identity} item={item} showProject={isGlobal} />)}
        </DashboardSection>
      </div>
    </main>
  );
}

function DashboardLoadError({ scope }: { scope: DashboardScope }) {
  return (
    <div role="alert" className="rounded-md border border-error/40 bg-error-muted px-3.5 py-3 text-sm text-error">
      {scope.kind === "project" ? "Couldn’t load this project’s dashboard." : "Couldn’t load the dashboard."}
    </div>
  );
}

function DashboardSection({
  id,
  icon,
  title,
  count,
  emptyMessage,
  children,
}: {
  id?: string;
  icon: React.ReactNode;
  title: string;
  count: number;
  emptyMessage: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} data-testid={`dashboard-section-${title.toLowerCase().replaceAll(" ", "-")}`} className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-[15px] font-semibold text-text-primary">{title}</h2>
        <span className="rounded-[10px] bg-bg-active px-[7px] py-[1px] text-[11px] font-semibold text-text-secondary">{count}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {count === 0 ? (
          <div className="rounded-md border border-dashed border-border-default bg-bg-surface/40 px-3.5 py-4 text-[12px] text-text-tertiary">
            {emptyMessage}
          </div>
        ) : children}
      </div>
    </section>
  );
}

function AttentionRow({ item, showProject }: { item: DashboardAttentionItem; showProject: boolean }) {
  const destination = attentionDestination(item);
  const inspection = item.kind === "hitl" && item.requiresInspection;
  const title = attentionTitle(item);
  const detail = attentionDetail(item);

  return (
    <div className={`flex items-center gap-3 rounded-md border px-3.5 py-2.5 ${inspection ? "border-error/50 bg-error-muted" : "border-warning/40 bg-bg-surface"}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-[13px] font-medium ${inspection ? "text-error" : "text-text-primary"}`}>{title}</span>
          {showProject ? <ProjectLabel name={item.projectName} /> : null}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-text-tertiary">{detail} · {formatRelativeTime(item.attentionSinceMs)}</p>
      </div>
      <OpenLink to={destination} />
    </div>
  );
}

function SessionRow({ item, showProject }: { item: DashboardSessionRow; showProject: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border-default bg-bg-surface px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-text-primary">{item.title ?? "Untitled session"}</span>
          {showProject ? <ProjectLabel name={item.projectName} /> : null}
          {item.goal ? <GoalStatus status={item.goal.status} /> : null}
        </div>
        <p className="mt-0.5 text-[11px] text-text-tertiary">Updated {formatRelativeTime(item.updatedAt)}</p>
      </div>
      <OpenLink to={sessionLink(item.projectSlug, item.rootSessionId)} />
    </div>
  );
}

function AutomationRow({ item, showProject }: { item: DashboardAutomationRow; showProject: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border-default bg-bg-surface px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-text-primary">{item.name}</span>
          {showProject ? <ProjectLabel name={item.projectName} /> : null}
        </div>
        <p className="mt-0.5 text-[11px] text-text-tertiary">Next run {new Date(item.nextFireAt).toLocaleString()}</p>
      </div>
      <OpenLink to={`/projects/${encodeURIComponent(item.projectSlug)}/automations/${encodeURIComponent(item.automationId)}`} />
    </div>
  );
}

function GoalStatus({ status }: { status: SessionGoalStatus }) {
  return <span className={`rounded px-1.5 py-[1px] text-[10.5px] font-medium ${GOAL_STATUS_CLASS[status]}`}>Goal · {status.replaceAll("_", " ")}</span>;
}

function ProjectLabel({ name }: { name: string }) {
  return <span className="shrink-0 text-[11px] text-text-muted">{name}</span>;
}

function OpenLink({ to }: { to: string }) {
  return <Link to={to} className="shrink-0 rounded-sm px-2 py-1 text-[12px] font-semibold text-accent hover:bg-accent-subtle hover:text-text-primary">Open</Link>;
}

function attentionDestination(item: DashboardAttentionItem): string {
  if (item.kind === "automation_failure") {
    return `/projects/${encodeURIComponent(item.projectSlug)}/automations/${encodeURIComponent(item.automationId)}?invocation=${encodeURIComponent(item.invocation.id)}`;
  }
  if (item.kind === "hitl") {
    const search = new URLSearchParams({ hitl: item.hitlId });
    if (item.ownerSessionId !== item.rootSessionId) search.set("focus", item.ownerSessionId);
    return `${sessionLink(item.projectSlug, item.rootSessionId)}?${search.toString()}`;
  }
  return sessionLink(item.projectSlug, item.rootSessionId);
}

function attentionTitle(item: DashboardAttentionItem): string {
  switch (item.kind) {
    case "hitl": return item.requiresInspection ? "Needs manual inspection" : item.displayPayload.title;
    case "goal": return item.goal.status === "budget_limited" ? "Goal budget limit reached" : "Goal is blocked";
    case "automation_failure": return "Automation dispatch failed";
    case "session_failure": return item.execution.status === "timed_out" ? "Session timed out" : "Session failed";
  }
}

function attentionDetail(item: DashboardAttentionItem): string {
  switch (item.kind) {
    case "hitl": return item.requiresInspection ? "A human needs to inspect this request" : item.displayPayload.summary ?? "Waiting for your response";
    case "goal": return item.goal.blockedReason ?? item.title ?? "Open the Session to continue this Goal";
    case "automation_failure": return item.automationName;
    case "session_failure": return item.title ?? "Untitled session";
  }
}

function sessionLink(projectSlug: string, rootSessionId: string): string {
  return `/projects/${encodeURIComponent(projectSlug)}/sessions/${encodeURIComponent(rootSessionId)}`;
}
