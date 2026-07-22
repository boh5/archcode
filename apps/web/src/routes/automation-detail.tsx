import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Pause, Play, Settings2, Trash2 } from "lucide-react";
import { useAutomation, useAutomationInvocations, useSession } from "../api/queries";
import { useDeleteAutomation, usePauseAutomation, useResumeAutomation, useRunAutomationNow } from "../api/mutations";
import type { Automation, AutomationInvocation } from "../api/types";
import { EditAutomationDialog } from "../components/features/EditAutomationDialog";
import { deriveAutomationHitlAttention, type AutomationHitlAttention } from "../lib/automation-hitl-attention";
import { hitlAttentionPath, useAttentionVisibleScopedHitl } from "../store/hitl-store";
import { formatTrigger } from "./automations";

export function AutomationDetailRoute() {
  const { slug = "", automationId = "" } = useParams<{ slug: string; automationId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const automation = useAutomation(slug, automationId);
  const invocations = useAutomationInvocations(slug, automationId);
  const scopedHitl = useAttentionVisibleScopedHitl([slug]);
  const runNow = useRunAutomationNow();
  const pause = usePauseAutomation();
  const resume = useResumeAutomation();
  const remove = useDeleteAutomation();

  if (automation.isLoading) return <div className="p-4 text-text-tertiary">Loading automation…</div>;
  if (!automation.data) return <div className="p-4 text-error">Automation not found</div>;

  const value = automation.data;
  const latestInvocation = invocations.data?.at(-1);
  const failedInvocation = latestInvocation?.status === "failed" ? latestInvocation : undefined;
  const targetInvocationId = searchParams.get("invocation");
  const hitlAttention = deriveAutomationHitlAttention(value, invocations.data ?? [], scopedHitl);

  return (
    <div className="flex h-full flex-col">
      <AutomationHeader
        automation={value}
        isRunningNow={runNow.isPending}
        onDelete={() => remove.mutate({ slug, automationId }, { onSuccess: () => navigate(`/projects/${slug}/automations`) })}
        onEdit={() => setEditing(true)}
        onPause={() => pause.mutate({ slug, automationId })}
        onResume={() => resume.mutate({ slug, automationId })}
        onRunNow={() => runNow.mutate({ slug, automationId })}
        slug={slug}
      />
      <main className="mx-auto w-full max-w-4xl space-y-4 overflow-y-auto p-4">
        <AutomationConfiguration automation={value} />
        <AutomationProvenance slug={slug} sessionId={(value as Automation & { createdFromSessionId: string }).createdFromSessionId} />
        <AutomationAttention failedInvocation={failedInvocation} hitlAttention={hitlAttention} />
        <InvocationHistory
          invocations={invocations.data}
          isLoading={invocations.isLoading}
          slug={slug}
          targetInvocationId={targetInvocationId}
        />
      </main>
      <EditAutomationDialog automation={value} onClose={() => setEditing(false)} open={editing} slug={slug} />
    </div>
  );
}

function AutomationProvenance({ slug, sessionId }: { slug: string; sessionId: string }) {
  const source = useSession(slug, sessionId);
  return (
    <section className="rounded-md border border-border-default bg-bg-surface p-4">
      <h2 className="font-semibold">Created from</h2>
      {sessionId && source.isLoading ? (
        <p className="mt-2 text-sm text-text-tertiary">Loading…</p>
      ) : sessionId && source.data ? (
        <Link className="mt-2 block text-sm text-accent hover:underline" to={`/projects/${slug}/sessions/${sessionId}`}>
          {source.data.title || sessionId}
        </Link>
      ) : (
        <p className="mt-2 text-sm text-text-tertiary">Unavailable</p>
      )}
    </section>
  );
}

function AutomationHeader({
  automation,
  isRunningNow,
  onDelete,
  onEdit,
  onPause,
  onResume,
  onRunNow,
  slug,
}: {
  automation: Automation;
  isRunningNow: boolean;
  onDelete: () => void;
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
  onRunNow: () => void;
  slug: string;
}) {
  return (
    <header className="flex h-12 items-center gap-3 border-b border-border-subtle px-4">
      <Link className="text-text-tertiary" to={`/projects/${slug}/automations`}>
        <ArrowLeft size={15} />
      </Link>
      <h1 className="min-w-0 flex-1 truncate font-semibold">{automation.name}</h1>
      <button onClick={onEdit} title="Edit Automation"><Settings2 size={15} /></button>
      <button className="inline-flex items-center gap-1 rounded-sm bg-accent px-3 py-1.5 text-sm text-bg-base" disabled={isRunningNow} onClick={onRunNow}>
        <Play size={14} /> Run now
      </button>
      {automation.status === "paused" ? (
        <button onClick={onResume}><Play size={15} /> Resume</button>
      ) : (
        <button onClick={onPause}><Pause size={15} /> Pause</button>
      )}
      <button onClick={onDelete} title="Delete Automation"><Trash2 size={15} /></button>
    </header>
  );
}

function AutomationConfiguration({ automation }: { automation: Automation }) {
  const action = automation.action.kind === "start_session"
    ? `Start a Lead Session in ${automation.action.location}`
    : `Send to Session ${automation.action.sessionId}`;

  return (
    <section className="rounded-md border border-border-default bg-bg-surface p-4">
      <h2 className="font-semibold">Configuration</h2>
      <dl className="mt-3 grid gap-2 text-sm">
        <AutomationDefinition label="Schedule">{formatTrigger(automation.trigger)}</AutomationDefinition>
        <AutomationDefinition label="Action">{action}</AutomationDefinition>
        <AutomationDefinition label="Message"><span className="whitespace-pre-wrap">{automation.action.message}</span></AutomationDefinition>
      </dl>
    </section>
  );
}

function AutomationDefinition({ children, label }: { children: React.ReactNode; label: string }) {
  return <div><dt className="text-text-muted">{label}</dt><dd>{children}</dd></div>;
}

function AutomationAttention({
  failedInvocation,
  hitlAttention,
}: {
  failedInvocation?: AutomationInvocation;
  hitlAttention: AutomationHitlAttention;
}) {
  const hasHitl = hitlAttention.kind === "start_session"
    ? hitlAttention.sessions.length > 0
    : hitlAttention.entries.length > 0;

  return (
    <section className="rounded-md border border-border-default bg-bg-surface p-4">
      <h2 className="font-semibold">Attention</h2>
      {failedInvocation ? (
        <p className="mt-2 text-sm text-error">Dispatch failed: {failedInvocation.error ?? failedInvocation.id}</p>
      ) : null}
      {hitlAttention.kind === "start_session" ? hitlAttention.sessions.map((session) => (
        <div className="mt-2 flex items-center justify-between gap-3 text-sm" key={session.invocationId}>
          <span>Invocation {session.invocationId}: Needs you</span>
          <Link className="text-accent hover:underline" to={hitlAttentionPath(session.entries[0]!)}>Open Session</Link>
        </div>
      )) : hitlAttention.entries[0] ? (
        <div className="mt-2 flex items-center justify-between gap-3 text-sm">
          <span>Target Session needs attention</span>
          <Link className="text-accent hover:underline" to={hitlAttentionPath(hitlAttention.entries[0])}>Open Session</Link>
        </div>
      ) : null}
      {!failedInvocation && !hasHitl ? (
        <p className="mt-2 text-sm text-text-tertiary">No failed dispatches. Session approvals and questions appear in the normal attention queue.</p>
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
    <section className="rounded-md border border-border-default bg-bg-surface p-4">
      <h2 className="font-semibold">Invocation History</h2>
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
      className={`rounded-sm py-2 text-sm outline-none ${targeted ? "bg-accent-subtle ring-1 ring-accent/50" : ""}`}
      data-invocation-id={item.id}
      tabIndex={targeted ? -1 : undefined}
    >
      <span className="font-medium">{item.status}</span>
      <span className="ml-2 text-text-muted">due {new Date(item.dueAt).toLocaleString()}</span>
      {item.sessionId ? <Link className="ml-2 text-accent hover:underline" to={`/projects/${slug}/sessions/${item.sessionId}`}>Open Session</Link> : null}
      {item.error ? <p className="text-error">{item.error}</p> : null}
    </div>
  );
}
