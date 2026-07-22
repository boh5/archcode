import { useEffect, useMemo, useRef } from "react";
import { selectSessionFamilyHitl, useAttentionVisibleScopedHitl, useHitlProjectInitialized } from "../../store/hitl-store";
import { useSessionFamilyActivity } from "../../store/session-runtime-store";
import { ConversationRail } from "../primitives/ConversationRail";
import { ChatInput } from "./ChatInput";
import { HitlDecisionCard } from "./HitlCard";
import type { SessionGoalView } from "../../api/types";
import { SessionGoalProgressRow } from "./SessionGoalProgressRow";
import { ComposerQueueList } from "./ComposerQueueList";

export function SessionComposerDock({
  slug,
  sessionId,
  goal,
  focusHitlId,
}: {
  slug: string;
  sessionId: string;
  goal?: SessionGoalView;
  focusHitlId?: string | null;
}) {
  const activity = useSessionFamilyActivity(slug, sessionId);
  const hitlReady = useHitlProjectInitialized(slug);
  const attentionVisibleHitl = useAttentionVisibleScopedHitl([slug]);
  const familyHitl = useMemo(
    () => selectSessionFamilyHitl(attentionVisibleHitl, slug, sessionId),
    [attentionVisibleHitl, sessionId, slug],
  );
  const hasPendingHitl = familyHitl.length > 0;
  const focusApplied = useRef<string | null>(null);

  useEffect(() => {
    if (!hitlReady || !focusHitlId || focusApplied.current === focusHitlId) return;
    const target = document.getElementById(`hitl-decision-${focusHitlId}`);
    if (!target) return;
    focusApplied.current = focusHitlId;
    target.scrollIntoView({ block: "nearest" });
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }, [focusHitlId, hitlReady, familyHitl]);

  return (
    <div
      className="flex max-h-[min(60dvh,640px)] shrink-0 flex-col overflow-hidden border-t border-border-subtle bg-bg-base max-[799px]:max-h-[min(70dvh,620px)]"
      data-testid="session-composer-dock"
      style={{ scrollbarGutter: "stable" }}
    >
      <ConversationRail className="flex min-h-0 flex-col gap-[8px] pb-[12px] pt-[8px]" data-testid="conversation-composer-rail">
        <SessionGoalProgressRow slug={slug} sessionId={sessionId} goal={goal} />
        <ComposerQueueList slug={slug} sessionId={sessionId} />
        {hasPendingHitl && (
          <div
            className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto rounded-[14px] border border-border-subtle bg-bg-surface p-[10px] shadow-sm"
            data-testid="composer-attention-stack"
          >
            <div className="flex flex-col gap-[8px]" aria-label="Requests needing attention">
              {familyHitl.map((entry) => <HitlDecisionCard key={`${entry.projectSlug}:${entry.ownerSessionId}:${entry.view.hitlId}`} entry={entry} />)}
            </div>
          </div>
        )}
        <div className="shrink-0" data-testid="composer-input-slot">
          <ChatInput
            slug={slug}
            sessionId={sessionId}
            activity={activity}
            hitlReady={hitlReady}
            hasPendingHitl={hasPendingHitl}
          />
        </div>
      </ConversationRail>
    </div>
  );
}
