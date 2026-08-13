import { useEffect, useMemo, useRef, useState } from "react";
import { selectSessionFamilyHitl, useAttentionVisibleScopedHitl, useHitlProjectInitialized } from "../../store/hitl-store";
import { useSessionFamilyActivity } from "../../store/session-runtime-store";
import { useSessionStore } from "../../store/session-store";
import { ConversationRail, SessionThreadColumn } from "../primitives/ConversationRail";
import { ChatInput } from "./ChatInput";
import { HitlDecisionCard } from "./HitlCard";
import { SessionGoalSummaryRow } from "./SessionGoalSummaryRow";
import { ComposerQueueList } from "./ComposerQueueList";

export function SessionComposerDock({
  slug,
  sessionId,
  focusHitlId,
  focusComposer = false,
  focusClientRequestId,
}: {
  slug: string;
  sessionId: string;
  focusHitlId?: string | null;
  focusComposer?: boolean;
  focusClientRequestId?: string | null;
}) {
  const activity = useSessionFamilyActivity(slug, sessionId);
  const goal = useSessionStore(sessionId, (state) => state.goal, slug);
  const executions = useSessionStore(sessionId, (state) => state.executions, slug);
  const currentExecutionId = useSessionStore(sessionId, (state) => state.currentExecutionId, slug);
  const hitlReady = useHitlProjectInitialized(slug);
  const attentionVisibleHitl = useAttentionVisibleScopedHitl([slug]);
  const familyHitl = useMemo(
    () => selectSessionFamilyHitl(attentionVisibleHitl, slug, sessionId),
    [attentionVisibleHitl, sessionId, slug],
  );
  const hasPendingHitl = familyHitl.length > 0;
  const currentExecution = currentExecutionId === undefined
    ? executions.at(-1)
    : executions.find((execution) => execution.id === currentExecutionId) ?? executions.at(-1);
  const terminalFailed = currentExecution?.status === "failed"
    || currentExecution?.status === "timed_out"
    || currentExecution?.status === "max_steps";
  const [activeHitlId, setActiveHitlId] = useState<string | null>(null);
  const focusApplied = useRef<string | null>(null);
  const activeHitlIndex = Math.max(0, familyHitl.findIndex((entry) => entry.view.hitlId === activeHitlId));
  const activeHitl = familyHitl[activeHitlIndex];

  useEffect(() => {
    if (familyHitl.length === 0) {
      setActiveHitlId(null);
      return;
    }
    if (focusHitlId && familyHitl.some((entry) => entry.view.hitlId === focusHitlId)) {
      setActiveHitlId(focusHitlId);
      return;
    }
    setActiveHitlId((current) => familyHitl.some((entry) => entry.view.hitlId === current)
      ? current
      : familyHitl[0].view.hitlId);
  }, [familyHitl, focusHitlId]);

  useEffect(() => {
    if (!hitlReady || !focusHitlId || focusApplied.current === focusHitlId) return;
    const target = document.getElementById(`hitl-decision-${focusHitlId}`);
    if (!target) return;
    focusApplied.current = focusHitlId;
    target.scrollIntoView({ block: "nearest" });
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }, [activeHitlId, focusHitlId, hitlReady, familyHitl]);

  return (
    <div
      className="relative z-[4] flex min-h-0 max-h-[min(52dvh,460px)] flex-[0_1_auto] flex-col overflow-visible border-t border-border-default bg-bg-base min-[761px]:max-h-[min(48dvh,520px)]"
      data-testid="session-composer-dock"
    >
      <div
        className="flex min-h-0 max-h-full flex-1 flex-col px-0 min-[761px]:px-[var(--session-scrollbar-gutter,0px)]"
        data-testid="composer-scrollbar-alignment"
      >
        <ConversationRail className="mx-auto flex min-h-0 max-h-full flex-1 flex-col !max-w-[900px] !px-3 pb-3 pt-2.5 min-[761px]:!px-[26px] min-[761px]:pb-[14px] min-[761px]:pt-3" data-testid="conversation-composer-rail">
          <SessionThreadColumn className="flex min-h-0 max-h-full flex-col gap-2.5 !max-w-[848px]" data-testid="composer-thread-column">
            <div
              className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5 overflow-x-hidden overflow-y-auto overscroll-contain"
              data-testid="composer-priority-stack"
            >
              {activeHitl && (
                <div
                  className="min-w-0 shrink-0"
                  data-testid="composer-attention-stack"
                >
                  <div className="min-w-0" aria-label="Requests needing attention">
                    <HitlDecisionCard
                      key={`${activeHitl.projectSlug}:${activeHitl.ownerSessionId}:${activeHitl.view.hitlId}`}
                      entry={activeHitl}
                      requestPosition={activeHitlIndex + 1}
                      requestCount={familyHitl.length}
                      onPreviousRequest={() => {
                        const previous = familyHitl[activeHitlIndex - 1];
                        if (previous) setActiveHitlId(previous.view.hitlId);
                      }}
                      onNextRequest={() => {
                        const next = familyHitl[activeHitlIndex + 1];
                        if (next) setActiveHitlId(next.view.hitlId);
                      }}
                    />
                  </div>
                </div>
              )}
              <SessionGoalSummaryRow slug={slug} sessionId={sessionId} goal={goal} />
              <ComposerQueueList slug={slug} sessionId={sessionId} focusClientRequestId={focusClientRequestId} />
            </div>
            <div className="relative z-[2] min-w-0 shrink-0" data-testid="composer-input-slot">
              <ChatInput
                slug={slug}
                sessionId={sessionId}
                activity={activity}
                hitlReady={hitlReady}
                hasPendingHitl={hasPendingHitl}
                terminalFailed={terminalFailed}
                focusOnReady={focusComposer}
              />
            </div>
          </SessionThreadColumn>
        </ConversationRail>
      </div>
    </div>
  );
}
