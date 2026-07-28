import { Activity, CircleDot, LayoutDashboard, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import type { DashboardScope, SessionGoal } from "@archcode/protocol";
import { useDashboardProjection } from "../hooks/use-dashboard-projection";
import type {
  DashboardAttentionItem,
  DashboardAutomationRow,
  DashboardSessionRow,
} from "../lib/dashboard-projection";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { RelativeTime } from "../components/primitives/TemporalText";
import { GoalStatusMark } from "../components/features/GoalStatusMark";
import { presentSessionGoalStatus } from "../lib/session-goal-presentation";
import { automationVisualKind } from "../lib/automation-status-presentation";
import { sessionFamilyActivityLabel, sessionFamilyVisual } from "../lib/session-family-presentation";
import { STATUS_TONE_CLASS, statusVisual } from "../lib/status-visuals";

const HOME_SCOPE: DashboardScope = { kind: "global" };

export function Dashboard({ scope = HOME_SCOPE }: { scope?: DashboardScope }) {
  const { data, sections, isLoading, error } = useDashboardProjection(scope);
  const isGlobal = scope.kind === "global";

  return (
    <main className="h-full overflow-y-auto bg-bg-base" data-testid={`dashboard-${scope.kind}`}>
      <div className="mx-auto flex max-w-[1180px] flex-col gap-[34px] px-4 pb-18 pt-8 min-[761px]:px-10 min-[761px]:pt-11.5">
        <header className="flex items-center gap-4">
          <span className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-lg border border-brand/20 bg-brand-subtle text-brand" aria-hidden="true">
            <LayoutDashboard size={21} strokeWidth={1.8} />
          </span>
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">Project overview</p>
            <h1 className="text-[26px] font-semibold leading-[30px] tracking-[-0.035em] text-text-primary">Dashboard</h1>
            <p className="mt-1.5 text-[14px] leading-[21px] text-text-secondary">
              What needs you, what is moving, and where to continue.
            </p>
          </div>
        </header>

        {error ? <DashboardLoadError scope={scope} /> : null}
        {data?.errors.map((projectError) => (
          <div
            key={projectError.projectSlug}
            role="alert"
            className="rounded-md border border-error/40 bg-error-muted px-4 py-3 text-sm text-error"
          >
            Couldn’t load dashboard data for {projectError.projectName}: {projectError.message}
          </div>
        ))}

        {isLoading ? (
          <div className="flex items-center gap-2 py-5 text-[13px] text-text-tertiary">
            <Loader2 size={14} className="animate-activity" aria-hidden="true" />
            Loading dashboard…
          </div>
        ) : null}

        <div className="grid min-w-0 grid-cols-1 gap-5 min-[1001px]:grid-cols-2">
          <DashboardSection
            id="needs-attention"
            icon={<StatusGlyph kind="needs_you" label="Needs attention" size={16} />}
            title="Needs attention"
            count={sections.attention.length}
            emptyMessage="Nothing needs your attention."
            emphasis="attention"
          >
            {sections.attention.map((item) => <AttentionRow key={item.identity} item={item} showProject={isGlobal} />)}
          </DashboardSection>

          <DashboardSection
            icon={<Activity size={16} className="text-signal-foreground" aria-hidden="true" />}
            title="Running now"
            count={sections.running.length}
            emptyMessage="No sessions are running."
            emphasis="running"
          >
            {sections.running.map((item) => <SessionRow key={item.identity} item={item} showProject={isGlobal} />)}
          </DashboardSection>
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-5 min-[1001px]:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.75fr)]">
          <DashboardSection
            icon={<CircleDot size={16} className="text-brand" aria-hidden="true" />}
            title="Continue working"
            count={sections.continueWorking.length}
            emptyMessage="No recent sessions to continue."
          >
            {sections.continueWorking.map((item) => <SessionRow key={item.identity} item={item} showProject={isGlobal} />)}
          </DashboardSection>

          <DashboardSection
            icon={<StatusGlyph kind="enabled" label="Upcoming automations" size={16} />}
            title="Upcoming"
            count={sections.upcoming.length}
            emptyMessage="No scheduled automations."
          >
            {sections.upcoming.map((item) => <AutomationRow key={item.identity} item={item} showProject={isGlobal} />)}
          </DashboardSection>
        </div>
      </div>
    </main>
  );
}

function DashboardLoadError({ scope }: { scope: DashboardScope }) {
  return (
    <div role="alert" className="border-y border-error/40 bg-error-muted px-4 py-3 text-sm text-error">
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
  emphasis = "default",
  children,
}: {
  id?: string;
  icon: React.ReactNode;
  title: string;
  count: number;
  emptyMessage: string;
  emphasis?: "default" | "attention" | "running";
  children: React.ReactNode;
}) {
  const emphasisClass = emphasis === "attention"
    ? "border-t-[3px] border-t-warning"
    : emphasis === "running"
      ? "border-t-[3px] border-t-signal"
      : "border-t border-t-border-default";
  return (
    <section
      id={id}
      data-testid={`dashboard-section-${title.toLowerCase().replaceAll(" ", "-")}`}
      className={`min-w-0 bg-bg-surface px-[18px] pb-2 pt-4 ${emphasisClass}`}
    >
      <div className="flex min-h-8 items-center gap-2 pb-3">
        {icon}
        <h2 className="text-[14px] font-semibold leading-5 text-text-primary">{title}</h2>
        <span className="min-w-5 rounded-full bg-bg-muted px-1.5 py-0.5 text-center text-[11px] font-semibold leading-[14px] tabular-nums text-text-tertiary">{count}</span>
      </div>
      <div className="divide-y divide-border-subtle border-t border-border-subtle">
        {count === 0 ? (
          <div className="flex min-h-[76px] items-center px-3 text-[12px] text-text-tertiary">
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
    <div className={`relative flex min-h-24 items-center gap-3 px-4 py-4 before:absolute before:inset-y-0 before:left-0 before:w-[3px] ${inspection ? "bg-error-muted before:bg-error" : "bg-warning-muted before:bg-warning"}`}>
      <StatusGlyph kind={inspection || item.kind === "automation_failure" || item.kind === "session_failure" ? "failed" : item.kind === "goal" && item.goal.status === "budget_limited" ? "budget_limited" : item.kind === "goal" ? "blocked" : "needs_you"} size={15} label={title} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-[14px] font-semibold ${inspection ? "text-error" : "text-text-primary"}`}>{title}</span>
          {showProject ? <ProjectLabel name={item.projectName} /> : null}
        </div>
        <p className="mt-1.5 truncate text-[12px] leading-[18px] text-text-tertiary">{detail} · <RelativeTime timestamp={item.attentionSinceMs} /></p>
      </div>
      <OpenLink to={destination} />
    </div>
  );
}

function SessionRow({ item, showProject }: { item: DashboardSessionRow; showProject: boolean }) {
  const visual = sessionFamilyVisual(item.activity);
  const label = sessionFamilyActivityLabel(item.activity);
  const active = item.activity !== "idle";
  const staticActivity = visual.kind === "running";
  const tone = visual.tone ?? statusVisual(visual.kind).tone;
  return (
    <div className={`relative flex items-center gap-3 px-4 py-3 ${active ? "min-h-24 bg-signal-field before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-signal" : "min-h-[76px] bg-bg-surface"}`}>
      {staticActivity
        ? <Activity size={15} className={STATUS_TONE_CLASS[tone]} aria-hidden="true" />
        : <StatusGlyph kind={visual.kind} tone={visual.tone} label={label} size={15} />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-text-primary">{item.title ?? "Untitled session"}</span>
          {showProject ? <ProjectLabel name={item.projectName} /> : null}
          {item.goal ? <GoalStatus goal={item.goal} /> : null}
          <span className="text-[12px] text-text-tertiary">{label}</span>
        </div>
        <p className="mt-1.5 text-[12px] text-text-tertiary">Updated <RelativeTime timestamp={item.updatedAt} /></p>
      </div>
      <OpenLink to={sessionLink(item.projectSlug, item.rootSessionId)} />
    </div>
  );
}

function AutomationRow({ item, showProject }: { item: DashboardAutomationRow; showProject: boolean }) {
  return (
    <div className="flex min-h-24 items-center gap-3 bg-bg-surface px-4 py-3">
      <StatusGlyph kind={automationVisualKind(item.status)} label={`Automation ${item.status}`} size={15} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-text-primary">{item.name}</span>
          {showProject ? <ProjectLabel name={item.projectName} /> : null}
        </div>
        <p className="mt-1.5 text-[12px] text-text-tertiary">Next run {new Date(item.nextFireAt).toLocaleString()}</p>
      </div>
      <OpenLink to={`/projects/${encodeURIComponent(item.projectSlug)}/automations/${encodeURIComponent(item.automationId)}`} />
    </div>
  );
}

function GoalStatus({ goal }: { goal: SessionGoal }) {
  const presentation = presentSessionGoalStatus(goal.status);
  return <span className="inline-flex items-center gap-1 text-[11px] font-medium text-text-secondary"><GoalStatusMark identity={goal.instanceId} status={goal.status} size={12} label={`Goal ${presentation.label}`} />{presentation.label}</span>;
}

function ProjectLabel({ name }: { name: string }) {
  return <span className="shrink-0 text-[11px] text-text-tertiary">{name}</span>;
}

function OpenLink({ to }: { to: string }) {
  return <Link to={to} className="shrink-0 rounded-sm px-2 py-1 text-[12px] font-semibold text-brand hover:bg-brand-subtle hover:text-text-primary">Open</Link>;
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
