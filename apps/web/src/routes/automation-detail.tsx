import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Pause, Play, Settings2, Trash2 } from "lucide-react";
import { projectTodoDisplayLabel } from "@archcode/protocol";
import { useAutomation, useAutomationInvocations, useProjectTodos, useSession } from "../api/queries";
import { usePauseAutomation, useResumeAutomation, useRunAutomationNow } from "../api/mutations";
import type { Automation, AutomationInvocation } from "../api/types";
import { EditAutomationDialog } from "../components/features/EditAutomationDialog";
import { deriveAutomationHitlAttention, type AutomationHitlAttention } from "../lib/automation-hitl-attention";
import { hitlAttentionPath, useAttentionVisibleScopedHitl } from "../store/hitl-store";
import { formatAutomationTrigger } from "../lib/automation-trigger-presentation";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { IconAction } from "../components/primitives/IconAction";
import { automationInvocationStatusLabel, automationStatusLabel, automationVisualKind } from "../lib/automation-status-presentation";
import { DeleteAutomationDialog } from "../components/features/DeleteAutomationDialog";
import { AutomationsRoute } from "./automations";

export function AutomationDetailRoute() {
  const { slug = "", automationId = "" } = useParams<{ slug: string; automationId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const automation = useAutomation(slug, automationId);
  const invocations = useAutomationInvocations(slug, automationId);
  const scopedHitl = useAttentionVisibleScopedHitl([slug]);
  const runNow = useRunAutomationNow();
  const pause = usePauseAutomation();
  const resume = useResumeAutomation();

  if (automation.isLoading) return <div className="p-4 text-text-tertiary">Loading automation…</div>;
  if (!automation.data) return <div className="p-4 text-error">Automation not found</div>;

  const value = automation.data;
  const latestInvocation = invocations.data?.at(-1);
  const problemInvocation = latestInvocation?.status === "failed" || latestInvocation?.status === "missed" ? latestInvocation : undefined;
  const targetInvocationId = searchParams.get("invocation");
  const hitlAttention = deriveAutomationHitlAttention(value, invocations.data ?? [], scopedHitl);
  const filterQuery = searchParams.get("q") ?? "";
  const automationsHref = `/projects/${slug}/automations${filterQuery ? `?q=${encodeURIComponent(filterQuery)}` : ""}`;

  return (
    <div className="flex h-full min-w-0 bg-bg-base">
      <aside className="hidden w-[360px] shrink-0 border-r border-border-default min-[841px]:block" aria-label="Automation list">
        <AutomationsRoute />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
      <AutomationHeader
        automation={value}
        automationsHref={automationsHref}
        isRunningNow={runNow.isPending}
        onDelete={() => setDeleting(true)}
        onEdit={() => setEditing(true)}
        onPause={() => pause.mutate({ slug, automationId })}
        onResume={() => resume.mutate({ slug, automationId })}
        onRunNow={() => runNow.mutate({ slug, automationId })}
      />
      <div className="mx-auto w-full max-w-[1100px] overflow-y-auto px-4 py-5 sm:px-6">
        <AutomationConfiguration automation={value} />
        <AutomationProvenance automation={value} slug={slug} />
        <AutomationAttention problemInvocation={problemInvocation} hitlAttention={hitlAttention} />
        <InvocationHistory
          invocations={invocations.data}
          isLoading={invocations.isLoading}
          slug={slug}
          targetInvocationId={targetInvocationId}
        />
      </div>
      <EditAutomationDialog automation={value} onClose={() => setEditing(false)} open={editing} slug={slug} />
      <DeleteAutomationDialog
        automation={value}
        onClose={() => setDeleting(false)}
        onDeleted={() => navigate(automationsHref)}
        open={deleting}
        slug={slug}
      />
      </div>
    </div>
  );
}

function AutomationProvenance({ automation, slug }: { automation: Automation; slug: string }) {
  const sessionId = automation.origin.kind === "direct" ? "" : automation.origin.sessionId;
  const todoId = automation.origin.kind === "todo" ? automation.origin.todoId : "";
  const source = useSession(slug, sessionId);
  const todos = useProjectTodos(slug);
  const linkedTodo = automation.origin.kind === "todo"
    ? todos.data?.find((todo) => todo.id === todoId)
    : undefined;
  return (
    <section className="border-t border-border-subtle py-4">
      <h2 className="text-[13px] font-semibold text-text-primary">Created from</h2>
      {automation.origin.kind === "direct" ? (
        <p className="mt-2 text-sm text-text-tertiary">Created directly in Automations</p>
      ) : (
        <div className="mt-2 flex flex-col gap-1 text-sm">
          {automation.origin.kind === "todo" ? (
            <Link className="text-brand hover:underline" to={`/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(automation.origin.todoId)}`}>
              Todo · {linkedTodo === undefined ? `${automation.origin.todoId} · unavailable` : projectTodoDisplayLabel(linkedTodo.content, linkedTodo.id)}
            </Link>
          ) : null}
          {source.isLoading ? (
            <p className="text-text-tertiary">Loading source Session…</p>
          ) : source.data ? (
            <Link className="text-brand hover:underline" to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`}>
              Session · {source.data.title || sessionId}
            </Link>
          ) : (
            <p className="text-text-tertiary">Session {sessionId} · unavailable</p>
          )}
        </div>
      )}
    </section>
  );
}

function AutomationHeader({
  automation,
  automationsHref,
  isRunningNow,
  onDelete,
  onEdit,
  onPause,
  onResume,
  onRunNow,
}: {
  automation: Automation;
  automationsHref: string;
  isRunningNow: boolean;
  onDelete: () => void;
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
  onRunNow: () => void;
}) {
  const statusLabel = automationStatusLabel(automation.status);
  return (
    <header className="flex min-h-14 flex-wrap items-center gap-2 border-b border-border-default bg-bg-surface px-4 py-2 min-[640px]:flex-nowrap min-[640px]:gap-3 min-[640px]:px-5">
      <Link
        aria-label="Back to automations"
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-transparent text-text-tertiary transition-colors duration-[var(--motion-hover)] hover:border-border-default hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
        state={{ restoreAutomationId: automation.id }}
        to={automationsHref}
      >
        <ArrowLeft aria-hidden="true" size={15} />
      </Link>
      <h1 className="min-w-0 flex-1 truncate text-[16px] font-semibold leading-[22px]">{automation.name}</h1>
      <span className="inline-flex shrink-0 items-center gap-2 text-xs text-text-secondary">
        <StatusGlyph kind={automationVisualKind(automation.status)} label={`Automation ${statusLabel}`} size={14} />
        {statusLabel}
      </span>
      <div className="flex w-full basis-full shrink-0 items-center justify-end gap-2 min-[640px]:w-auto min-[640px]:basis-auto">
        <IconAction label="Edit automation" onClick={onEdit}><Settings2 aria-hidden="true" size={15} /></IconAction>
        <button className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-sm bg-brand px-3 text-[12px] font-medium text-bg-overlay transition-colors duration-[var(--motion-hover)] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:h-11" disabled={isRunningNow} onClick={onRunNow}>
          <Play aria-hidden="true" size={14} /> Run now
        </button>
        {automation.status === "paused" ? (
          <button className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-sm bg-bg-active px-3 text-[12px] font-medium text-text-primary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:h-11" onClick={onResume}><Play aria-hidden="true" size={15} /> Resume</button>
        ) : (
          <button className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-sm bg-bg-active px-3 text-[12px] font-medium text-text-primary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:h-11" onClick={onPause}><Pause aria-hidden="true" size={15} /> Pause</button>
        )}
        <IconAction danger label="Delete automation" onClick={onDelete}><Trash2 aria-hidden="true" size={15} /></IconAction>
      </div>
    </header>
  );
}

function AutomationConfiguration({ automation }: { automation: Automation }) {
  const action = automation.action.kind === "start_session"
    ? `Start a Lead Session in ${automation.action.location}`
    : `Send to Session ${automation.action.sessionId}`;
  const workspace = automation.action.kind === "start_session"
    ? automation.action.location === "project" ? "Project workspace" : "Fresh worktree"
    : "Target Session workspace";

  return (
    <section className="border-t border-border-subtle py-4">
      <h2 className="text-[13px] font-semibold text-text-primary">Configuration</h2>
      <dl className="mt-3 grid gap-2 text-sm">
        <AutomationDefinition label="Stable ID"><span className="font-mono text-[12px]">{automation.id}</span></AutomationDefinition>
        <AutomationDefinition label="Updated">{new Date(automation.updatedAt).toLocaleString()}</AutomationDefinition>
        <AutomationDefinition label="Schedule">{formatAutomationTrigger(automation.trigger)}</AutomationDefinition>
        <AutomationDefinition label="Action">{action}</AutomationDefinition>
        <AutomationDefinition label="Workspace">{workspace}</AutomationDefinition>
        <AutomationDefinition label="Message"><span className="whitespace-pre-wrap">{automation.action.message}</span></AutomationDefinition>
      </dl>
    </section>
  );
}

function AutomationDefinition({ children, label }: { children: React.ReactNode; label: string }) {
  return <div><dt className="text-[11px] leading-4 text-text-tertiary">{label}</dt><dd>{children}</dd></div>;
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

  return (
    <section className="border-t border-border-subtle py-4">
      <h2 className="text-[13px] font-semibold text-text-primary">Attention</h2>
      {problemInvocation ? (
        <p className="mt-2 inline-flex items-center gap-2 text-sm text-error"><StatusGlyph kind="failed" size={14} />Dispatch {problemInvocation.status}: {problemInvocation.error ?? problemInvocation.id}</p>
      ) : null}
      {hitlAttention.kind === "start_session" ? hitlAttention.sessions.map((session) => (
        <div className="mt-2 flex items-center justify-between gap-3 text-sm" key={session.invocationId}>
          <span className="inline-flex items-center gap-2"><StatusGlyph kind="needs_you" size={14} />Invocation {session.invocationId}: Needs you</span>
          <Link className="text-brand hover:underline" to={hitlAttentionPath(session.entries[0]!)}>Open Session</Link>
        </div>
      )) : hitlAttention.entries[0] ? (
        <div className="mt-2 flex items-center justify-between gap-3 text-sm">
          <span className="inline-flex items-center gap-2"><StatusGlyph kind="needs_you" size={14} />Target Session needs attention</span>
          <Link className="text-brand hover:underline" to={hitlAttentionPath(hitlAttention.entries[0])}>Open Session</Link>
        </div>
      ) : null}
      {!problemInvocation && !hasHitl ? (
        <p className="mt-2 text-sm text-text-tertiary">No failed or missed dispatches. Session approvals and questions appear in the normal attention queue.</p>
      ) : null}
    </section>
  );
}

function InvocationHistory({ invocations, isLoading, slug, targetInvocationId }: {
  invocations?: AutomationInvocation[];
  isLoading: boolean;
  slug: string;
  targetInvocationId: string | null;
}) {
  return (
    <section className="border-t border-border-subtle py-4">
      <h2 className="text-[13px] font-semibold text-text-primary">Invocation History</h2>
      {isLoading ? <p className="mt-2 text-sm text-text-tertiary">Loading history…</p> : null}
      {!isLoading && !invocations?.length ? <p className="mt-2 text-sm text-text-tertiary">No invocations yet.</p> : null}
      {invocations?.length ? <div className="mt-2 divide-y divide-border-subtle">{invocations.map((item) => (
        <InvocationRow item={item} key={item.id} slug={slug} targeted={item.id === targetInvocationId} />
      ))}</div> : null}
    </section>
  );
}

function InvocationRow({ item, slug, targeted }: { item: AutomationInvocation; slug: string; targeted: boolean }) {
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!targeted) return;
    rowRef.current?.scrollIntoView({ block: "center" });
    rowRef.current?.focus({ preventScroll: true });
  }, [targeted]);

  return (
    <div
      ref={rowRef}
      className={`border-l-2 py-2 pl-3 text-sm outline-none ${targeted ? "border-l-brand bg-brand-subtle" : "border-l-transparent"}`}
      data-invocation-id={item.id}
      tabIndex={targeted ? -1 : undefined}
    >
      <span className="font-medium">{automationInvocationStatusLabel(item.status)}</span>
      <span className="ml-2 text-[11px] leading-4 text-text-tertiary">due {new Date(item.dueAt).toLocaleString()}</span>
      {item.sessionId ? <Link className="ml-2 text-brand hover:underline" to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(item.sessionId)}?invocation=${encodeURIComponent(item.id)}`}>Open Session</Link> : null}
      {item.error ? <p className="text-error">{item.error}</p> : null}
    </div>
  );
}
