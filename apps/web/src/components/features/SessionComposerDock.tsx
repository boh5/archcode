import { useEffect, useMemo, useRef, useState } from "react";
import { selectSessionFamilyHitl, useAttentionVisibleScopedHitl, useHitlProjectInitialized } from "../../store/hitl-store";
import { useSessionFamilyActivity } from "../../store/session-runtime-store";
import { useSessionStore } from "../../store/session-store";
import { ConversationRail, SessionThreadColumn } from "../primitives/ConversationRail";
import { ChatInput } from "./ChatInput";
import { HitlDecisionCard } from "./HitlCard";
import { SessionGoalSummaryRow } from "./SessionGoalSummaryRow";
import { ComposerQueueList } from "./ComposerQueueList";

interface ComposerDisclosureSnapshot {
  collapsedHitlIds: Set<string>;
  inspectionHitlIds: Set<string>;
}

const composerDisclosureByRoute = new Map<string, ComposerDisclosureSnapshot>();
const composerRouteLifecycleGeneration = new Map<string, number>();

function composerDisclosureKey(slug: string, sessionId: string): string {
  return `${slug}\u0000${sessionId}`;
}

function getComposerDisclosureSnapshot(
  slug: string,
  sessionId: string,
): ComposerDisclosureSnapshot {
  const key = composerDisclosureKey(slug, sessionId);
  const existing = composerDisclosureByRoute.get(key);
  if (existing) return existing;
  const created = {
    collapsedHitlIds: new Set<string>(),
    inspectionHitlIds: new Set<string>(),
  };
  composerDisclosureByRoute.set(key, created);
  return created;
}

function retainComposerDisclosureState(
  slug: string,
  sessionId: string,
): () => void {
  const key = composerDisclosureKey(slug, sessionId);
  const generation = (composerRouteLifecycleGeneration.get(key) ?? 0) + 1;
  composerRouteLifecycleGeneration.set(key, generation);
  return () => {
    queueMicrotask(() => {
      if (composerRouteLifecycleGeneration.get(key) !== generation) return;
      composerRouteLifecycleGeneration.delete(key);
      composerDisclosureByRoute.delete(key);
    });
  };
}

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
  const scopedProjectSlugs = useMemo(() => [slug], [slug]);
  const attentionVisibleHitl = useAttentionVisibleScopedHitl(scopedProjectSlugs);
  const familyHitl = useMemo(
    () => selectSessionFamilyHitl(attentionVisibleHitl, slug, sessionId),
    [attentionVisibleHitl, sessionId, slug],
  );
  const pendingHitlIds = useMemo(
    () => new Set(
      familyHitl
        .filter((entry) => entry.view.status === "pending")
        .map((entry) => entry.view.hitlId),
    ),
    [familyHitl],
  );
  const attentionHitlIds = useMemo(
    () => new Set(familyHitl.map((entry) => entry.view.hitlId)),
    [familyHitl],
  );
  const inspectionHitlIds = useMemo(
    () => new Set(
      familyHitl
        .filter((entry) => entry.view.requiresInspection === true)
        .map((entry) => entry.view.hitlId),
    ),
    [familyHitl],
  );
  const hasPendingHitl = pendingHitlIds.size > 0;
  const currentExecution = currentExecutionId === undefined
    ? executions.at(-1)
    : executions.find((execution) => execution.id === currentExecutionId) ?? executions.at(-1);
  const terminalFailed = currentExecution?.status === "failed"
    || currentExecution?.status === "timed_out"
    || currentExecution?.status === "max_steps";
  const [activeHitlId, setActiveHitlId] = useState<string | null>(null);
  const disclosureSnapshot = useMemo(
    () => getComposerDisclosureSnapshot(slug, sessionId),
    [sessionId, slug],
  );
  const [collapsedHitlIds, setCollapsedHitlIds] = useState<Set<string>>(
    () => new Set(disclosureSnapshot.collapsedHitlIds),
  );
  const focusApplied = useRef<string | null>(null);
  const activeHitlIndex = Math.max(0, familyHitl.findIndex((entry) => entry.view.hitlId === activeHitlId));
  const activeHitl = familyHitl[activeHitlIndex];

  useEffect(
    () => retainComposerDisclosureState(slug, sessionId),
    [sessionId, slug],
  );

  useEffect(() => {
    setCollapsedHitlIds(new Set(disclosureSnapshot.collapsedHitlIds));
  }, [disclosureSnapshot]);

  useEffect(() => {
    const next = new Set(
      [...disclosureSnapshot.collapsedHitlIds]
        .filter((hitlId) => attentionHitlIds.has(hitlId)),
    );
    for (const hitlId of inspectionHitlIds) {
      if (!disclosureSnapshot.inspectionHitlIds.has(hitlId)) next.delete(hitlId);
    }
    disclosureSnapshot.collapsedHitlIds = next;
    disclosureSnapshot.inspectionHitlIds = new Set(inspectionHitlIds);
    setCollapsedHitlIds((current) => {
      if (current.size === next.size && [...current].every((id) => next.has(id))) {
        return current;
      }
      return new Set(next);
    });
  }, [attentionHitlIds, disclosureSnapshot, inspectionHitlIds]);

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
      className={`relative z-[4] flex min-h-0 flex-[0_1_auto] flex-col overflow-visible border-0 bg-transparent ${hasPendingHitl
        ? "max-h-[min(78dvh,640px)]"
        : "max-h-[min(52dvh,460px)] min-[761px]:max-h-[min(48dvh,520px)]"
      }`}
      data-testid="session-composer-dock"
    >
      <div
        className="flex min-h-0 max-h-full flex-1 flex-col px-0 min-[761px]:px-[var(--session-scrollbar-gutter,0px)]"
        data-testid="composer-scrollbar-alignment"
      >
        <ConversationRail className="mx-auto flex min-h-0 max-h-full flex-1 flex-col !max-w-[900px] !px-3 pb-3 pt-2.5 min-[761px]:!px-[26px] min-[761px]:pb-4 min-[761px]:pt-[14px]" data-testid="conversation-composer-rail">
          <SessionThreadColumn className="flex min-h-0 max-h-full flex-col gap-2 !max-w-[848px]" data-testid="composer-thread-column">
            <div
              className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto overscroll-contain"
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
                      expanded={!collapsedHitlIds.has(activeHitl.view.hitlId)}
                      onExpandedChange={(expanded) => {
                        const next = new Set(collapsedHitlIds);
                        if (expanded) next.delete(activeHitl.view.hitlId);
                        else next.add(activeHitl.view.hitlId);
                        setCollapsedHitlIds(new Set(next));
                        disclosureSnapshot.collapsedHitlIds = new Set(
                          [...next].filter((hitlId) => attentionHitlIds.has(hitlId)),
                        );
                      }}
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
