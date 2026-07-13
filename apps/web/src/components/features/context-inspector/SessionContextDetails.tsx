import { Link, useParams, useSearchParams } from "react-router-dom";
import { useAutomations, useGoals, useSession } from "../../../api/queries";
import { useSessionStore } from "../../../store/session-store";
import { InspectorNotice, InspectorRows, InspectorSection, InspectorValue } from "./InspectorPrimitives";

export function SessionContextDetails() {
  const { slug = "", sessionId = "" } = useParams<{ slug: string; sessionId: string }>();
  const [searchParams] = useSearchParams();
  const focused = searchParams.get("focus") ?? sessionId;
  const { data: session, isLoading } = useSession(slug, focused);
  const { data: goals } = useGoals(slug);
  const { data: automations } = useAutomations(slug);
  const hydrationStatus = useSessionStore(focused, (state) => state.hydrationStatus, slug);
  const liveCwd = useSessionStore(focused, (state) => state.cwd, slug);
  const liveModelInfo = useSessionStore(focused, (state) => state.modelInfo, slug);
  const liveStats = useSessionStore(focused, (state) => state.stats, slug);
  const liveExecutions = useSessionStore(focused, (state) => state.executions, slug);

  if (isLoading) return <InspectorNotice>Loading context…</InspectorNotice>;
  if (!session) return <InspectorNotice>Session context unavailable</InspectorNotice>;
  const useLiveContext = hydrationStatus === "hydrated";
  const cwd = useLiveContext ? (liveCwd ?? session.cwd) : session.cwd;
  const modelInfo = useLiveContext ? liveModelInfo : session.modelInfo;
  const stats = useLiveContext ? liveStats : session.stats;
  const executions = useLiveContext ? liveExecutions : session.executions;
  const relatedGoals = (goals ?? []).filter((goal) => (goal as unknown as { createdFromSessionId: string }).createdFromSessionId === focused);
  const relatedAutomations = (automations ?? []).filter((automation) => (automation as unknown as { createdFromSessionId: string }).createdFromSessionId === focused);
  return (
    <div className="space-y-4">
      <InspectorSection title="Working directory">
        <code className="break-all text-[11px] text-text-secondary">{cwd}</code>
      </InspectorSection>
      <InspectorSection title="Model">
        <InspectorValue>{modelInfo?.displayName ?? modelInfo?.modelId ?? "Not recorded"}</InspectorValue>
      </InspectorSection>
      <InspectorSection title="Execution">
        <InspectorRows rows={[
          ["Messages", String(stats.messages.total)],
          ["Tool calls", String(stats.tools.calls)],
          ["Tokens", stats.usage.totalTokens.toLocaleString()],
          ["Executions", String(executions.length)],
        ]} />
      </InspectorSection>
      {session.goalId && <InspectorSection title="Executing Goal"><Link className="block text-xs text-accent hover:underline" to={`/projects/${slug}/goals/${session.goalId}`}>Open executing goal</Link></InspectorSection>}
      {(relatedGoals.length > 0 || relatedAutomations.length > 0) && (
        <InspectorSection title="Related work">
          <div className="space-y-1">
            <div className="px-2 text-[10px] font-semibold uppercase tracking-wide text-text-muted">Created here</div>
            {relatedGoals.map((goal) => (
              <Link
                key={`goal-${goal.id}`}
                className="block rounded-sm px-2 py-1.5 text-xs hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent"
                to={`/projects/${slug}/goals/${goal.id}`}
              >
                <span className="font-medium text-text-primary">{goal.title || "Untitled goal"}</span>
                <span className="ml-2 text-text-muted">Goal · {goal.status}</span>
              </Link>
            ))}
            {relatedAutomations.map((automation) => (
              <Link
                key={`automation-${automation.id}`}
                className="block rounded-sm px-2 py-1.5 text-xs hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent"
                to={`/projects/${slug}/automations/${automation.id}`}
              >
                <span className="font-medium text-text-primary">{automation.name}</span>
                <span className="ml-2 text-text-muted">Automation · {automation.status}</span>
                {automation.nextFireAt && <span className="ml-2 text-text-muted">next {new Date(automation.nextFireAt).toLocaleString()}</span>}
              </Link>
            ))}
          </div>
        </InspectorSection>
      )}
    </div>
  );
}
