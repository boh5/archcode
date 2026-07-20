import { isVisibleHitlView, useHitlProjectInitialized, useRealtimeHitl } from "../../store/hitl-store";
import { useSessionFamilyActivity } from "../../store/session-runtime-store";
import { ConversationRail } from "../primitives/ConversationRail";
import { ChatInput } from "./ChatInput";
import { HitlInbox } from "./HitlCard";
import type { SessionGoalView } from "../../api/types";
import { SessionGoalProgressRow } from "./SessionGoalProgressRow";

export function SessionComposerDock({ slug, sessionId, goal }: { slug: string; sessionId: string; goal?: SessionGoalView }) {
  const activity = useSessionFamilyActivity(slug, sessionId);
  const hitlReady = useHitlProjectInitialized(slug);
  const hitlViews = useRealtimeHitl({ slug, scope: "session", ownerId: sessionId });
  const visibleHitlViews = hitlViews.filter(isVisibleHitlView);
  const hasPendingHitl = visibleHitlViews.length > 0;

  return (
    <div className="shrink-0 bg-bg-base" data-testid="session-composer-dock">
      <ConversationRail className="pb-[12px] pt-[8px]" data-testid="conversation-composer-rail">
        <div className="flex flex-col gap-[8px]">
          <SessionGoalProgressRow slug={slug} sessionId={sessionId} goal={goal} />
          {hasPendingHitl && (
            <div
              className="max-h-[min(64vh,560px)] min-w-0 overflow-x-hidden overflow-y-auto rounded-[14px] border border-border-subtle bg-bg-surface p-[10px] shadow-sm"
              data-testid="composer-attention-stack"
            >
              <HitlInbox
                views={visibleHitlViews}
                projectSlug={slug}
                hideWhenEmpty
                className="gap-[8px]"
                title="Needs attention"
                showOwnerLink={false}
              />
            </div>
          )}
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
