import { getWebSessionStore } from "../../store/session-store";
import { formatElapsed } from "../../lib/time-format";
import { CornerDownRight } from "lucide-react";
import type { DelegationCardViewModel } from "../../lib/delegation-card-model";
import { STATUS_TONE_CLASS, statusVisual } from "../../lib/status-visuals";
import { StatusGlyph } from "../primitives/StatusGlyph";
import { useStatusTransition } from "../primitives/useStatusTransition";
import { ToolInputDetails } from "./ToolInputDetails";

export function DelegationCard({
  sessionId,
  focusStoreSessionId,
  taskTitle,
  visualKind,
  executionStatusLabel,
  executionStatusDetail,
  startedAt,
  hasInput,
  input,
  projectSlug,
  canNavigate = true,
}: DelegationCardViewModel) {
  const statusTransition = useStatusTransition(sessionId, visualKind);
  const handleViewConversation = () => {
    if (!canNavigate) return;
    const store = getWebSessionStore(focusStoreSessionId, projectSlug);
    store.getState().setFocusSessionId(sessionId);
  };

  return (
    <div className="my-2 min-h-0 shrink-0 overflow-hidden rounded-md border border-border-subtle bg-bg-elevated" data-tool-name="delegate">
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-transparent px-3 py-2">
        <CornerDownRight size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
        <span className="font-mono text-[12px] font-medium text-text-primary">delegate</span>
        <span
          className={`inline-flex items-center gap-2 text-[12px] font-semibold ${STATUS_TONE_CLASS[statusVisual(visualKind).tone]}`}
          data-child-visual-kind={visualKind}
          aria-label={`Child status: ${executionStatusLabel}`}
          title={executionStatusDetail ? `${executionStatusLabel} · ${executionStatusDetail}` : executionStatusLabel}
        >
          <StatusGlyph kind={visualKind} size={14} transition={statusTransition} />
          {executionStatusLabel}
          {executionStatusDetail && <span className="ml-1 font-normal opacity-70">· {executionStatusDetail}</span>}
        </span>
        {taskTitle && <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary" title={taskTitle}>{taskTitle}</span>}
        {!taskTitle && <span className="flex-1" />}
        {visualKind === "running" && startedAt !== undefined && (
          <span className="text-[11px] text-text-tertiary">{formatElapsed(startedAt)}</span>
        )}
        {canNavigate ? (
          <button
            type="button"
            className="h-8 shrink-0 rounded-sm bg-brand-subtle px-3 text-[12px] font-medium text-brand transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-brand"
            onClick={handleViewConversation}
          >
            Open child session
          </button>
        ) : (
          <span className="shrink-0 text-[11px] text-text-tertiary">Child session pending</span>
        )}
      </div>

      {hasInput && <ToolInputDetails input={input} />}
    </div>
  );
}
