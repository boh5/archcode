import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
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
  const automationsHref = `/projects/${slug}/automations${filterQuery ? `?q=${encodeURIComponent(filterQuery)}` : ""}`;
  const detailStatusClass = presentation.tone === "error"
    ? "bg-error-muted text-error"
    : presentation.tone === "attention"
      ? "bg-warning-muted text-warning"
      : presentation.tone === "running" || presentation.statusLabel === "Scheduled"
        ? "bg-signal-field text-signal-foreground"
        : "bg-bg-muted text-text-tertiary";

  return (
    <AutomationsRoute detail={(
      <article className="mx-auto w-full max-w-[820px] px-3 pb-12 pt-[22px] min-[841px]:px-[22px] min-[841px]:pb-16 min-[841px]:pt-6 min-[1041px]:px-8">
        <Link
          className="mb-2 inline-flex min-h-[44px] items-center gap-1.5 text-[11px] text-text-secondary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] min-[841px]:hidden"
          state={{ restoreAutomationId: value.id }}
          to={automationsHref}
        >
          <ArrowLeft aria-hidden="true" size={14} /> Automations
        </Link>
        <div className="flex items-center gap-2 text-[9px] font-[680] uppercase text-text-tertiary">
          <span className={`inline-flex min-h-[22px] items-center rounded-[10px] px-[7px] ${detailStatusClass}`}>{presentation.statusLabel}</span>
          <span>Updated <RelativeTime timestamp={Date.parse(value.updatedAt)} /></span>
        </div>
        <div className="mt-2.5 block gap-[18px] border-b border-border-default pb-5 min-[761px]:flex min-[761px]:items-end min-[761px]:justify-between">
          <h1 ref={titleRef} tabIndex={-1} className="min-w-0 text-[21px] font-[680] leading-[1.2] tracking-[-0.03em] focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] min-[761px]:text-[26px]">{value.name}</h1>
          <div className="mt-[14px] flex shrink-0 items-center gap-2 min-[761px]:mt-0">
            <button type="button" onClick={() => setEditing(true)} className="inline-flex h-[44px] items-center justify-center rounded-sm border border-border-default bg-bg-active px-[13px] text-[12px] font-semibold tracking-[-0.01em] text-text-secondary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] min-[761px]:h-8">Edit</button>
            <PrimaryActionButton disabled={runNow.isPending} onClick={() => runNow.mutate({ slug, automationId })}>
              Run now
            </PrimaryActionButton>
          </div>
        </div>
        <AutomationConfiguration automation={value} presentation={presentation} />
        <AutomationProvenance automation={value} linkedTodoContent={linkedTodoContent} slug={slug} />
        <AutomationAttention problemInvocation={problemInvocation} hitlAttention={hitlAttention} />
        <InvocationHistory
          invocations={invocations.data}
          isLoading={invocations.isLoading}
          activityBySessionId={activityBySessionId}
          sessionsById={sessionsById}
          slug={slug}
          targetInvocationId={targetInvocationId}
        />
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
    return <DetailSection title="Created from"><p className="mt-2.5 text-[13px] leading-[1.65] text-text-secondary">Created directly in Automations.</p></DetailSection>;
  }
  return (
    <DetailSection title={automation.origin.kind === "todo" ? "Linked Todo" : "Created from"}>
      {automation.origin.kind === "todo" ? (
        <Link className="mt-2.5 flex items-center justify-between gap-3 rounded-md border border-border-default px-3 py-[11px] text-text-secondary transition-colors duration-[var(--motion-hover)] hover:border-brand hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]" to={`/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(automation.origin.todoId)}`}>
          <span className="min-w-0"><strong className="block truncate text-[11px] font-[640]">{linkedTodoContent === undefined ? automation.origin.todoId : projectTodoContentExcerpt(linkedTodoContent)}</strong><small className="mt-[3px] block text-[9px] text-text-tertiary">Todo · stable detail</small></span><span className="shrink-0 text-[11px] font-[640]">Open →</span>
        </Link>
      ) : null}
      {source.isLoading ? (
        <p className="mt-2.5 text-[11px] text-text-tertiary">Loading source Session…</p>
      ) : source.data ? (
        <Link className="mt-2.5 inline-flex text-[11px] font-semibold text-brand hover:underline" to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`}>
          Session · {source.data.title || sessionId}
        </Link>
      ) : (
        <p className="mt-2.5 text-[11px] text-text-tertiary">Session {sessionId} · unavailable</p>
      )}
    </DetailSection>
  );
}

function AutomationConfiguration({ automation, presentation }: { automation: Automation; presentation: AutomationSurfacePresentation }) {
  return (
    <>
      <DetailSection title="Schedule & execution">
        <dl className="mt-3 grid grid-cols-1 gap-x-7 min-[761px]:grid-cols-2">
          <AutomationFact label="Trigger">{formatAutomationTrigger(automation.trigger)}</AutomationFact>
          <AutomationFact label="Next run">{presentation.nextRunLabel}</AutomationFact>
          <AutomationFact label="Action">{presentation.actionLabel}</AutomationFact>
          <AutomationFact label="Location">{presentation.locationLabel}</AutomationFact>
          <AutomationFact label="Binding">{presentation.bindingLabel}</AutomationFact>
          <AutomationFact label="Stable ID">{automation.id}</AutomationFact>
        </dl>
      </DetailSection>
      <DetailSection title="Message"><p className="mt-2.5 whitespace-pre-wrap text-[13px] leading-[1.65] text-text-secondary">{automation.action.message}</p></DetailSection>
    </>
  );
}

function DetailSection({ children, title }: { children: React.ReactNode; title: string }) {
  return <section className="border-b border-border-subtle py-5"><h2 className="text-[11px] font-[680] uppercase tracking-[0.06em] text-text-tertiary">{title}</h2>{children}</section>;
}

function AutomationFact({ children, label }: { children: React.ReactNode; label: string }) {
  return <div className="grid min-w-0 grid-cols-[72px_minmax(0,1fr)] items-baseline gap-3 border-t border-border-subtle py-2.5 min-[761px]:grid-cols-[76px_minmax(0,1fr)]"><dt className="text-[9px] uppercase text-text-tertiary">{label}</dt><dd className="truncate font-mono text-[10px] font-[560] text-text-primary">{children}</dd></div>;
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
    <DetailSection title="Recent runs">
      <p className="mt-2.5 text-[13px] leading-[1.65] text-text-secondary">Invocation state is separate from Session result: <code>dispatched</code> is never <code>Completed</code>.</p>
      {isLoading ? <p className="mt-2.5 text-[11px] text-text-tertiary">Loading history…</p> : null}
      {!isLoading && !invocations?.length ? <p className="py-5 text-center text-[11px] text-text-tertiary">No runs yet. Run now will create the first durable Session.</p> : null}
      {invocations?.length ? <div className="mt-2.5 border-t border-border-subtle">{invocations.map((item) => (
        <InvocationRow
          activity={item.sessionId ? activityBySessionId.get(item.sessionId) : undefined}
          item={item}
          key={item.id}
          linkedSession={item.sessionId ? sessionsById.get(item.sessionId) : undefined}
          slug={slug}
          targeted={item.id === targetInvocationId}
        />
      ))}</div> : null}
    </DetailSection>
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

  useEffect(() => {
    if (!targeted) return;
    rowRef.current?.scrollIntoView({ block: "center" });
    rowRef.current?.focus({ preventScroll: true });
  }, [targeted]);

  return (
    <div
      ref={rowRef}
      className={`grid min-h-[43px] grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-[9px] border-b border-border-subtle text-[10px] text-text-secondary outline-none ${targeted ? "bg-brand-subtle shadow-[inset_2px_0_0_var(--brand)]" : ""}`}
      data-invocation-id={item.id}
      tabIndex={targeted ? -1 : undefined}
    >
      <StatusGlyph kind={visualKind} size={10} />
      {item.sessionId ? <Link className="truncate hover:text-text-primary" to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(item.sessionId)}?invocation=${encodeURIComponent(item.id)}`}>{runLabel} · Open Session</Link> : <span className="truncate">{automationInvocationStatusLabel(item.status)}{item.error ? ` · ${item.error}` : ""}</span>}
      <time className="text-[9px] text-text-tertiary">{new Date(item.dueAt).toLocaleString()}</time>
    </div>
  );
}
