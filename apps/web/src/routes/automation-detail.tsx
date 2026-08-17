import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ChevronRight, ListTodo, Pencil, Play } from "lucide-react";
import { projectTodoContentExcerpt, type SessionFamilyActivity } from "@archcode/protocol";
import { useAutomation, useAutomationInvocations, useProjectTodos, useSession, useSessionInventory } from "../api/queries";
import { usePauseAutomation, useResumeAutomation, useRunAutomationNow } from "../api/mutations";
import type { Automation, AutomationInvocation, ProjectSessionInventoryItem } from "../api/types";
import { EditAutomationDialog } from "../components/features/EditAutomationDialog";
import { deriveAutomationHitlAttention, indexAutomationSessionLinks, type AutomationHitlAttention } from "../lib/automation-hitl-attention";
import { hitlAttentionPath, useAttentionVisibleScopedHitl } from "../store/hitl-store";
import { formatAutomationTrigger } from "../lib/automation-trigger-presentation";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { PrimaryActionButton } from "../components/primitives/PrimaryActionButton";
import { RelativeTime } from "../components/primitives/TemporalText";
import { automationInvocationStatusLabel } from "../lib/automation-status-presentation";
import { presentAutomationSurface, type AutomationSurfacePresentation } from "../lib/automation-surface-presentation";
import { useSessionRuntimeFamilies } from "../store/session-runtime-store";
import { AutomationsRoute } from "./automations";

export function AutomationDetailRoute() {
  const { slug = "", automationId = "" } = useParams<{ slug: string; automationId: string }>();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [editing, setEditing] = useState(false);
  const automation = useAutomation(slug, automationId);
  const invocations = useAutomationInvocations(slug, automationId);
  const sessionInventory = useSessionInventory(slug);
  const todos = useProjectTodos(slug);
  const scopedHitl = useAttentionVisibleScopedHitl([slug]);
  const runtimeFamilies = useSessionRuntimeFamilies();
  const runNow = useRunAutomationNow();
  const pause = usePauseAutomation();
  const resume = useResumeAutomation();
  const sessionLinksByAutomation = useMemo(
    () => indexAutomationSessionLinks(sessionInventory.data ?? []),
    [sessionInventory.data],
  );
  const sessionsById = useMemo(
    () => new Map((sessionInventory.data ?? []).map((item) => [item.session.sessionId, item])),
    [sessionInventory.data],
  );
  const activityBySessionId = useMemo(() => new Map(
    Object.values(runtimeFamilies)
      .filter((family) => family.projectSlug === slug)
      .map((family) => [family.rootSessionId, family.activity] as const),
  ), [runtimeFamilies, slug]);

  useEffect(() => {
    const shouldFocus = typeof location.state === "object"
      && location.state !== null
      && "focusAutomationDetail" in location.state
      && location.state.focusAutomationDetail === true;
    if (!shouldFocus || typeof window.matchMedia !== "function" || !window.matchMedia("(max-width: 840px)").matches) return;
    const frame = window.requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [automation.data?.id, location.state]);

  if (automation.isLoading) return <AutomationsRoute detail={<p className="p-6 text-[13px] text-text-tertiary">Loading automation…</p>} />;
  if (!automation.data) return <AutomationsRoute detail={<p className="p-6 text-[13px] text-error">Automation not found</p>} />;

  const value = automation.data;
  const latestInvocation = invocations.data?.at(-1);
  const problemInvocation = latestInvocation?.status === "failed" || latestInvocation?.status === "missed" ? latestInvocation : undefined;
  const targetInvocationId = searchParams.get("invocation");
  const sessionLinks = sessionLinksByAutomation.get(value.id) ?? [];
  const hitlAttention = deriveAutomationHitlAttention(value, sessionLinks, scopedHitl);
  const linkedTodoId = value.origin.kind === "todo" ? value.origin.todoId : undefined;
  const linkedTodoContent = linkedTodoId
    ? todos.data?.find((todo) => todo.id === linkedTodoId)?.content
    : undefined;
  const presentation = presentAutomationSurface({
    item: { automation: value, latestInvocation: latestInvocation ?? null },
    attention: hitlAttention,
    sessionLinks,
    targetSession: value.action.kind === "send_message" ? sessionsById.get(value.action.sessionId) : undefined,
    activityBySessionId,
    linkedTodoContent,
  });
  const filterQuery = searchParams.get("q") ?? "";
  const filterStatus = searchParams.get("status");
  const automationsQuery = new URLSearchParams({
    ...(filterQuery ? { q: filterQuery } : {}),
    ...(filterStatus === "active" || filterStatus === "paused" ? { status: filterStatus } : {}),
  }).toString();
  const automationsHref = `/projects/${slug}/automations${automationsQuery ? `?${automationsQuery}` : ""}`;
  const detailStatusClass = presentation.tone === "error"
    ? "text-error"
    : presentation.tone === "attention"
      ? "text-warning"
      : presentation.tone === "running" || presentation.statusLabel === "Scheduled"
        ? "text-signal-foreground"
        : "text-text-tertiary";

  return (
    <AutomationsRoute detail={(
      <article className="w-full bg-bg-surface">
        <header className="border-b border-border-default p-4">
          <Link
            className="mb-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-sm text-[11px] text-text-secondary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] min-[841px]:hidden"
            state={{ restoreAutomationId: value.id }}
            to={automationsHref}
          >
            <ArrowLeft aria-hidden="true" size={14} /> Schedules
          </Link>
          <span className={`block text-[10.5px] font-bold uppercase leading-[21px] tracking-[0.09em] ${detailStatusClass}`}>
            {presentation.statusLabel} · Updated <RelativeTime timestamp={Date.parse(value.updatedAt)} />
          </span>
          <h1 ref={titleRef} tabIndex={-1} className="mt-1 min-w-0 text-[16px] font-semibold leading-[1.35] tracking-[-0.02em] text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]">{value.name}</h1>
        </header>
        <AutomationProvenance automation={value} linkedTodoContent={linkedTodoContent} slug={slug} />
        <AutomationConfiguration automation={value} presentation={presentation} />
        <AutomationAttention problemInvocation={problemInvocation} hitlAttention={hitlAttention} />
        <InvocationHistory
          invocations={invocations.data}
          isLoading={invocations.isLoading}
          activityBySessionId={activityBySessionId}
          sessionsById={sessionsById}
          slug={slug}
          targetInvocationId={targetInvocationId}
        />
        <footer className="flex justify-end gap-[7px] border-t border-border-default px-4 py-3">
          <button type="button" onClick={() => setEditing(true)} className="inline-flex h-[34px] min-h-[34px] items-center justify-center gap-1.5 rounded-sm border border-border-default bg-bg-surface px-3 text-[11px] font-semibold text-text-secondary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(max-width:840px)]:h-11">
            <Pencil size={13} aria-hidden="true" /> Edit
          </button>
          <PrimaryActionButton disabled={runNow.isPending} className="min-[841px]:!h-[34px]" onClick={() => runNow.mutate({ slug, automationId })}>
            <Play size={13} aria-hidden="true" /> Run now
          </PrimaryActionButton>
        </footer>
        <EditAutomationDialog
          automation={value}
          lifecyclePending={pause.isPending || resume.isPending}
          onClose={() => setEditing(false)}
          onDeleted={() => navigate(automationsHref)}
          onPause={() => pause.mutate({ slug, automationId }, { onSuccess: () => setEditing(false) })}
          onResume={() => resume.mutate({ slug, automationId }, { onSuccess: () => setEditing(false) })}
          open={editing}
          slug={slug}
        />
      </article>
    )} />
  );
}

function AutomationProvenance({ automation, linkedTodoContent, slug }: { automation: Automation; linkedTodoContent?: string; slug: string }) {
  const sessionId = automation.origin.kind === "direct" ? "" : automation.origin.sessionId;
  const source = useSession(slug, sessionId);
  if (automation.origin.kind === "direct") {
    return <div className="m-[14px] rounded-[7px] border border-border-default bg-bg-muted px-3 py-2.5"><span className="block text-[10.5px] font-bold uppercase leading-[1.5] tracking-[0.09em] text-text-tertiary">Created from</span><p className="mt-[5px] text-[11px] leading-[1.5] text-text-secondary">Created directly in Schedules.</p></div>;
  }
  return (
    <>
      {automation.origin.kind === "todo" ? (
        <Link className="m-[14px] grid grid-cols-[28px_minmax(0,1fr)_14px] items-center gap-[9px] rounded-lg border border-border-default bg-bg-muted p-2.5 text-text-secondary transition-colors duration-[var(--motion-fast)] hover:border-brand hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]" to={`/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(automation.origin.todoId)}`}>
          <span aria-hidden="true" className="grid h-[27px] w-[27px] place-items-center rounded-[7px] border border-brand/25 bg-brand-field text-brand"><ListTodo size={12} /></span>
          <span className="min-w-0"><small className="block text-[10.5px] uppercase tracking-[0.08em] text-text-tertiary">Linked Todo</small><strong className="mt-0.5 block truncate text-[12px] font-semibold">{linkedTodoContent === undefined ? automation.origin.todoId : projectTodoContentExcerpt(linkedTodoContent)}</strong></span>
          <ChevronRight size={13} className="text-text-tertiary" aria-hidden="true" />
        </Link>
      ) : null}
      <div className="m-[14px] rounded-[7px] border border-border-default bg-bg-muted px-3 py-2.5">
        <span className="block text-[10.5px] font-bold uppercase leading-[1.5] tracking-[0.09em] text-text-tertiary">Created from</span>
        {source.isLoading ? (
          <p className="mt-[5px] text-[11px] text-text-tertiary">Loading source Session…</p>
        ) : source.data ? (
          <Link className="mt-[5px] inline-flex text-[11px] font-semibold text-brand hover:underline" to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`}>
            Session · {source.data.title || sessionId}
          </Link>
        ) : (
          <p className="mt-[5px] text-[11px] text-text-tertiary">Session {sessionId} · unavailable</p>
        )}
      </div>
    </>
  );
}

function AutomationConfiguration({ automation, presentation }: { automation: Automation; presentation: AutomationSurfacePresentation }) {
  return (
    <>
      <dl className="m-0 px-4">
        <AutomationFact label="Trigger">{formatAutomationTrigger(automation.trigger)}</AutomationFact>
        <AutomationFact label="Next run">{presentation.nextRunLabel}</AutomationFact>
        <AutomationFact label="Action">{presentation.actionLabel}</AutomationFact>
        <AutomationFact label="Location">{presentation.locationLabel}</AutomationFact>
        <AutomationFact label="Binding">{presentation.bindingLabel}</AutomationFact>
        <AutomationFact label="Stable ID" mono>{automation.id}</AutomationFact>
      </dl>
      <section className="border-y border-border-default p-4"><span className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-text-tertiary">Message</span><p className="mt-[5px] whitespace-pre-wrap text-[11px] leading-[1.55] text-text-secondary">{automation.action.message}</p></section>
    </>
  );
}

function DetailSection({ children, title }: { children: React.ReactNode; title: string }) {
  return <section className="p-4"><h2 className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-text-tertiary">{title}</h2>{children}</section>;
}

function AutomationFact({ children, label, mono = false }: { children: React.ReactNode; label: string; mono?: boolean }) {
  return <div className="flex min-h-[34px] min-w-0 items-center justify-between gap-3 border-b border-border-default"><dt className="shrink-0 text-[10.5px] text-text-tertiary">{label}</dt><dd className={`m-0 min-w-0 truncate text-right text-[10.5px] text-text-secondary ${mono ? "font-mono" : ""}`}>{children}</dd></div>;
}

function AutomationAttention({
  problemInvocation,
  hitlAttention,
}: {
  problemInvocation?: AutomationInvocation;
  hitlAttention: AutomationHitlAttention;
}) {
  const hasHitl = hitlAttention.kind === "start_session"
    ? hitlAttention.sessions.length > 0
    : hitlAttention.entries.length > 0;

  if (!problemInvocation && !hasHitl) return null;

  if (problemInvocation) {
    const label = problemInvocation.status === "failed" ? "Dispatch failed" : "Dispatch missed its due time";
    return (
      <DetailSection title="Attention">
        <p className="mt-2.5 inline-flex items-center gap-2 text-[13px] leading-[1.65] text-error">
          <StatusGlyph kind="failed" size={14} />{label}{problemInvocation.error ? `: ${problemInvocation.error}` : "."}
        </p>
      </DetailSection>
    );
  }

  return (
    <DetailSection title="Attention">
      {hitlAttention.kind === "start_session" ? hitlAttention.sessions.map((session) => (
        <div className="mt-2.5 flex items-center justify-between gap-3 text-[13px]" key={session.invocationId}>
          <span className="inline-flex items-center gap-2"><StatusGlyph kind="needs_you" size={14} />Invocation {session.invocationId}: Needs you</span>
          <Link className="text-[11px] font-semibold text-brand hover:underline" to={hitlAttentionPath(session.entries[0]!)}>Open Session</Link>
        </div>
      )) : hitlAttention.entries[0] ? (
        <div className="mt-2.5 flex items-center justify-between gap-3 text-[13px]">
          <span className="inline-flex items-center gap-2"><StatusGlyph kind="needs_you" size={14} />Target Session needs you</span>
          <Link className="text-[11px] font-semibold text-brand hover:underline" to={hitlAttentionPath(hitlAttention.entries[0])}>Open Session</Link>
        </div>
      ) : null}
    </DetailSection>
  );
}

function InvocationHistory({ activityBySessionId, invocations, isLoading, sessionsById, slug, targetInvocationId }: {
  activityBySessionId: ReadonlyMap<string, SessionFamilyActivity>;
  invocations?: AutomationInvocation[];
  isLoading: boolean;
  sessionsById: ReadonlyMap<string, ProjectSessionInventoryItem>;
  slug: string;
  targetInvocationId: string | null;
}) {
  return (
    <section className="p-4">
      <header className="mb-2 flex items-end justify-between gap-3">
        <div><span className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-text-tertiary">Recent runs</span><h2 className="mt-0.5 text-[13px] font-semibold text-text-primary">History</h2></div>
        <Link className="text-[10.5px] font-semibold text-brand hover:underline focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]" to={`/projects/${encodeURIComponent(slug)}/sessions`}>All runs</Link>
      </header>
      {isLoading ? <p className="py-4 text-[11px] text-text-tertiary">Loading history…</p> : null}
      {!isLoading && !invocations?.length ? <p className="py-5 text-center text-[11px] text-text-tertiary">No runs yet. The first dispatched Invocation will appear here.</p> : null}
      {invocations?.length ? <div>{invocations.map((item) => (
        <InvocationRow
          activity={item.sessionId ? activityBySessionId.get(item.sessionId) : undefined}
          item={item}
          key={item.id}
          linkedSession={item.sessionId ? sessionsById.get(item.sessionId) : undefined}
          slug={slug}
          targeted={item.id === targetInvocationId}
        />
      ))}</div> : null}
    </section>
  );
}

function InvocationRow({ activity, item, linkedSession, slug, targeted }: {
  activity?: SessionFamilyActivity;
  item: AutomationInvocation;
  linkedSession?: ProjectSessionInventoryItem;
  slug: string;
  targeted: boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const executionStatus = linkedSession?.latestExecution?.status;
  const actualRunning = executionStatus === "running" || activity === "running" || activity === "resuming";
  const visualKind = item.status === "failed" || item.status === "missed"
    ? "failed"
    : item.status === "cancelled"
      ? "stopped"
      : item.status === "pending"
        ? "pending"
        : actualRunning
          ? "running"
          : executionStatus === "completed"
            ? "completed"
            : executionStatus === "failed" || executionStatus === "timed_out" || executionStatus === "max_steps"
              ? "failed"
              : executionStatus === "suspended"
                ? "blocked"
                : executionStatus
                  ? "stopped"
                  : "idle";
  const runLabel = actualRunning
    ? "Running"
    : executionStatus === "completed"
      ? "Completed"
      : executionStatus === "failed" || executionStatus === "timed_out" || executionStatus === "max_steps"
        ? "Failed"
        : executionStatus === "suspended"
          ? "Suspended"
          : automationInvocationStatusLabel(item.status);
  const due = new Date(item.dueAt);

  useEffect(() => {
    if (!targeted) return;
    rowRef.current?.scrollIntoView({ block: "center" });
    rowRef.current?.focus({ preventScroll: true });
  }, [targeted]);

  return (
    <div
      ref={rowRef}
      className={`grid min-h-[47px] grid-cols-[27px_minmax(0,1fr)_auto] items-center gap-2 border-b border-border-default text-text-secondary outline-none ${targeted ? "bg-brand-subtle shadow-[inset_2px_0_0_var(--brand)]" : ""}`}
      data-invocation-id={item.id}
      tabIndex={targeted ? -1 : undefined}
    >
      <span aria-hidden="true" className="grid h-[27px] w-[27px] place-items-center rounded-[7px] border border-border-subtle bg-bg-muted"><StatusGlyph kind={visualKind} size={12} /></span>
      {item.sessionId ? <Link className="min-w-0 hover:text-text-primary" to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(item.sessionId)}?invocation=${encodeURIComponent(item.id)}`}><strong className="block truncate text-[12px] font-semibold">{due.toLocaleString()}</strong><small className="block truncate text-[10.5px] text-text-tertiary">{runLabel} · Open Session</small></Link> : <span className="min-w-0"><strong className="block truncate text-[12px] font-semibold">{due.toLocaleString()}</strong><small className="block truncate text-[10.5px] text-text-tertiary">{automationInvocationStatusLabel(item.status)}{item.error ? ` · ${item.error}` : ""}</small></span>}
      <time className="font-mono text-[10.5px] text-text-tertiary" dateTime={item.dueAt}>{due.toLocaleDateString(undefined, { weekday: "short" })}</time>
    </div>
  );
}
