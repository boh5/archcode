import { getWebSessionStore } from "../../store/session-store";
import { BADGE_CLASSES } from "../../lib/agent-constants";
import { formatElapsed } from "../../lib/time-format";
import { CornerDownRight } from "lucide-react";
import type { DelegationCardViewModel } from "../../lib/delegation-card-model";

export function DelegationCard({
  sessionId,
  focusStoreSessionId,
  agentDisplayName,
  profile,
  skills,
  taskTitle,
  executionStatus,
  executionStatusLabel,
  executionStatusDetail,
  startedAt,
  taskSummary,
  background,
  projectSlug,
  canNavigate = true,
}: DelegationCardViewModel) {
  const handleViewConversation = () => {
    if (!canNavigate) return;
    const store = getWebSessionStore(focusStoreSessionId, projectSlug);
    store.getState().setFocusSessionId(sessionId);
  };

  return (
    <div className="my-2.5 min-h-0 shrink-0 overflow-hidden rounded-lg border border-border-default bg-bg-surface" data-tool-name="delegate">
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-bg-elevated px-3.5 py-2.5">
        <CornerDownRight size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
        <span className="font-mono text-[12px] font-medium text-text-primary">delegate</span>
        <span
          className={`px-2 py-[2px] rounded-[10px] text-[10.5px] font-semibold ${BADGE_CLASSES[executionStatus]}`}
          aria-label={`Child status: ${executionStatusLabel}`}
          title={executionStatusDetail ? `${executionStatusLabel} · ${executionStatusDetail}` : executionStatusLabel}
        >
          {executionStatusLabel}
          {executionStatusDetail && <span className="ml-1 font-normal opacity-70">· {executionStatusDetail}</span>}
        </span>
        {taskTitle && <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary" title={taskTitle}>{taskTitle}</span>}
        {!taskTitle && <span className="flex-1" />}
        {executionStatus === "running" && startedAt !== undefined && (
          <span className="text-[11px] text-text-muted">{formatElapsed(startedAt)}</span>
        )}
        {canNavigate ? (
          <button
            type="button"
            className="shrink-0 rounded-sm bg-accent-subtle px-2.5 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent-muted focus-visible:outline-2 focus-visible:outline-accent"
            onClick={handleViewConversation}
          >
            Open child session
          </button>
        ) : (
          <span className="shrink-0 text-[11px] text-text-muted">Child session pending</span>
        )}
      </div>

      {(agentDisplayName || profile || background !== undefined || skills.length > 0 || taskSummary) && (
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3.5 py-2.5 text-[12px]">
        {agentDisplayName && <><dt className="text-text-muted">Agent</dt><dd className="min-w-0 truncate text-text-primary">{agentDisplayName}</dd></>}
        {profile && <><dt className="text-text-muted">Profile</dt><dd className="font-mono text-text-secondary">{profile}</dd></>}
        {background !== undefined && <><dt className="text-text-muted">Mode</dt><dd className="text-text-secondary">{background ? "Background" : "Foreground"}</dd></>}
        {skills.length > 0 && <><dt className="text-text-muted">Skills</dt><dd className="min-w-0 break-words font-mono text-text-secondary">{skills.join(", ")}</dd></>}
        {taskSummary && <><dt className="text-text-muted">Goal</dt><dd className="whitespace-pre-wrap text-text-secondary">{taskSummary}</dd></>}
      </dl>
      )}
    </div>
  );
}
