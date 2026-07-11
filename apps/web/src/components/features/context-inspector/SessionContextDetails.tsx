import { Link, useParams, useSearchParams } from "react-router-dom";
import { useSession } from "../../../api/queries";
import { useSessionStore } from "../../../store/session-store";
import { InspectorNotice, InspectorRows, InspectorSection, InspectorValue } from "./InspectorPrimitives";

export function SessionContextDetails() {
  const { slug = "", sessionId = "" } = useParams<{ slug: string; sessionId: string }>();
  const [searchParams] = useSearchParams();
  const focused = searchParams.get("focus") ?? sessionId;
  const { data: session, isLoading } = useSession(slug, focused);
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
      {session.goalId && <Link className="block text-xs text-accent hover:underline" to={`/projects/${slug}/goals/${session.goalId}`}>Open linked goal</Link>}
      {session.loopId && <Link className="block text-xs text-accent hover:underline" to={`/projects/${slug}/loops/${session.loopId}`}>Open linked loop</Link>}
    </div>
  );
}
