import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, Pause, Play, RotateCcw, Settings2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { useLoop, useLoopBudget, useLoopCollisions, useLoopIntegrations, useLoopKillState, useLoopRuns, useLoopState } from "../api/queries";
import { useActivateLoopGlobalKill, useCancelLoopCurrentRun, useClearLoopGlobalKill, usePauseLoop, useResumeLoop, useTriggerLoop } from "../api/mutations";
import { EditLoopDialog } from "../components/features/CreateLoopDialog";
import { HitlInbox } from "../components/features/HitlCard";
import { useRealtimeHitl } from "../store/hitl-store";
import { formatRunHistoryBadgeClass, formatRunHistoryLabel } from "../lib/loop-status";
import { useWorkbenchLayout } from "../context/workbench-layout";
import { InspectorToggleButton } from "../components/features/InspectorToggleButton";
import type {
  LoopBudgetSnapshot,
  LoopCollisionSnapshot,
  LoopConfig,
  LoopIntegrationError,
  LoopIntegrationStatusSnapshot,
  LoopKillState,
  LoopRunReport,
  LoopState,
  LoopTriggerHealth,
  LoopWorktreeArtifact,
} from "../api/types";

export function LoopDetailRoute() {
  const { slug = "", loopId = "" } = useParams<{ slug: string; loopId: string }>();
  const layout = useWorkbenchLayout();
  const { toggleInspectorSurface } = layout;
  const { data: loop, isLoading: loopLoading, error: loopError } = useLoop(slug, loopId);
  const { data: runs, isLoading: runsLoading, error: runsError } = useLoopRuns(slug, loopId);
  const { data: loopState, isLoading: stateLoading, error: stateError } = useLoopState(slug, loopId);
  const { data: budget, isLoading: budgetLoading } = useLoopBudget(slug, loopId);
  const { data: collisions, isLoading: collisionsLoading } = useLoopCollisions(slug, loopId);
  const { data: integrations, isLoading: integrationsLoading } = useLoopIntegrations(slug, loopId);
  const { data: killState } = useLoopKillState(slug);
  const loopHitl = useRealtimeHitl({
    slug,
    scope: "loop",
    ownerId: loopId,
    includeChildren: true,
  });
  const triggerLoop = useTriggerLoop();
  const pauseLoop = usePauseLoop();
  const resumeLoop = useResumeLoop();
  const cancelCurrentRun = useCancelLoopCurrentRun();
  const activateGlobalKill = useActivateLoopGlobalKill();
  const clearGlobalKill = useClearLoopGlobalKill();
  const [editOpen, setEditOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const mutationError = formatMutationError(
    triggerLoop.error,
    pauseLoop.error,
    resumeLoop.error,
    cancelCurrentRun.error,
    activateGlobalKill.error,
    clearGlobalKill.error,
  );

  if (!slug || !loopId) {
    return (
      <div className="flex h-full items-center justify-center text-error text-sm">
        Missing loop route parameters
      </div>
    );
  }

  if (loopLoading) {
    return (
      <div className="flex h-full items-center justify-center text-text-secondary text-sm gap-2">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        Loading loop...
      </div>
    );
  }

  if (loopError || !loop) {
    const message = loopError instanceof Error ? loopError.message : "Loop not found";
    return (
      <div className="flex h-full flex-col">
        <BackBar slug={slug} />
        <div className="flex-1 flex items-center justify-center text-error text-sm">
          {message}
        </div>
      </div>
    );
  }

  const handleTrigger = () => {
    triggerLoop.mutate({ slug, loopId });
  };

  const handleCancelCurrentRun = () => {
    cancelCurrentRun.mutate({ slug, loopId });
  };

  const handleActivateGlobalKill = () => {
    activateGlobalKill.mutate({ slug, activatedBy: "web", reason: "Activated from Loop detail guardrail controls" });
  };

  const handleClearGlobalKill = () => {
    clearGlobalKill.mutate({ slug });
  };

  const handlePause = () => {
    pauseLoop.mutate({ slug, loopId });
  };

  const handleResume = () => {
    resumeLoop.mutate({ slug, loopId });
  };

  const globalKillActive = killState?.globalKillActive === true;
  const hardBudgetBlocked = isHardBudgetBlocked(budget ?? loop.latestBudget, loop);
  const triggerBlockedReason = globalKillActive
    ? "Global kill is active for this project. Clear it before triggering runs."
    : hardBudgetBlocked
      ? "Hard budget guardrail has paused execution. Adjust budget or clear the runtime pause before triggering."
      : null;

  return (
    <div data-testid="loop-detail-page" className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-4 h-12 border-b border-border-subtle shrink-0 bg-bg-surface">
        <Link
          to={`/projects/${slug}/loops`}
          className="flex items-center gap-1 text-text-tertiary hover:text-text-primary transition-colors duration-150 cursor-pointer text-[12.5px]"
        >
          <ArrowLeft size={14} />
          Loops
        </Link>
        <span className="text-text-muted">/</span>
        <span className="font-semibold text-sm text-text-primary truncate">{loop.config.title || "Untitled"}</span>
        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            data-testid="loop-edit-button"
            onClick={() => setEditOpen(true)}
            aria-label="Edit loop"
            title="Edit loop"
            className="inline-flex items-center gap-1.5 rounded-sm bg-bg-active px-3 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
          >
            <Settings2 size={13} />
            <span className="max-[900px]:hidden">Edit Loop</span>
          </button>
          <button
            type="button"
            onClick={handleTrigger}
            disabled={triggerLoop.isPending || triggerBlockedReason !== null}
            aria-label="Trigger manual run"
            title={triggerBlockedReason ?? undefined}
            className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-[12.5px] font-medium text-bg-base transition-colors duration-150 hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Play size={13} />
            <span className="max-[900px]:hidden">{triggerLoop.isPending ? "Triggering…" : "Trigger manual run"}</span>
          </button>
          <button
            type="button"
            onClick={handlePause}
            disabled={pauseLoop.isPending}
            aria-label="Pause loop"
            title="Pause loop"
            className="inline-flex items-center gap-1.5 rounded-sm bg-bg-active px-3 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Pause size={13} />
            <span className="max-[900px]:hidden">{pauseLoop.isPending ? "Pausing…" : "Pause"}</span>
          </button>
          <button
            type="button"
            onClick={handleResume}
            disabled={resumeLoop.isPending}
            aria-label="Resume loop"
            title="Resume loop"
            className="inline-flex items-center gap-1.5 rounded-sm bg-bg-active px-3 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RotateCcw size={13} />
            <span className="max-[900px]:hidden">{resumeLoop.isPending ? "Resuming…" : "Resume"}</span>
          </button>
          <InspectorToggleButton expanded={layout.inspectorExpanded} onToggle={toggleInspectorSurface} />
        </div>
      </div>

      {mutationError && (
        <div className="border-b border-border-subtle bg-error-muted px-4 py-2 text-xs text-error" role="alert">
          {mutationError}
        </div>
      )}

      {triggerBlockedReason && (
        <div className="border-b border-border-subtle bg-warning-muted px-4 py-2 text-xs text-warning" role="status">
          {triggerBlockedReason}
        </div>
      )}

      <div className="flex-1 overflow-y-auto bg-bg-base">
        <div className="max-w-5xl mx-auto w-full px-4 py-4 flex flex-col gap-4">
          <AttentionSection
            killState={killState}
            loop={loop}
            onCancelCurrentRun={handleCancelCurrentRun}
            onActivateGlobalKill={handleActivateGlobalKill}
            onClearGlobalKill={handleClearGlobalKill}
            cancelPending={cancelCurrentRun.isPending}
            activateKillPending={activateGlobalKill.isPending}
            clearKillPending={clearGlobalKill.isPending}
          />
          <LoopHitlSection projections={loopHitl} />
          <RecentResultsSection slug={slug} runs={runs} isLoading={runsLoading} error={runsError} />
          <AdvancedDebugSection
            open={debugOpen}
            onToggle={() => setDebugOpen((prev) => !prev)}
            slug={slug}
            loop={loop}
            runs={runs}
            runsLoading={runsLoading}
            runsError={runsError}
            loopState={loopState}
            stateLoading={stateLoading}
            stateError={stateError}
            budget={budget ?? loop.latestBudget ?? null}
            budgetLoading={budgetLoading}
            collisions={collisions ?? loop.latestCollisions}
            collisionsLoading={collisionsLoading}
            integrations={integrations ?? integrationSnapshotFromLoop(loop)}
            integrationsLoading={integrationsLoading}
          />
        </div>
      </div>
      <EditLoopDialog open={editOpen} onClose={() => setEditOpen(false)} slug={slug} loop={loop} />
    </div>
  );
}

function BackBar({ slug }: { slug: string }) {
  return (
    <div className="flex items-center gap-3 px-4 h-12 border-b border-border-subtle shrink-0 bg-bg-surface">
      <Link
        to={`/projects/${slug}/loops`}
        className="flex items-center gap-1 text-text-tertiary hover:text-text-primary transition-colors duration-150 cursor-pointer text-[12.5px]"
      >
        <ArrowLeft size={14} />
        Loops
      </Link>
    </div>
  );
}

function AttentionSection({
  killState,
  loop,
  onCancelCurrentRun,
  onActivateGlobalKill,
  onClearGlobalKill,
  cancelPending,
  activateKillPending,
  clearKillPending,
}: {
  killState: LoopKillState | undefined;
  loop: LoopState;
  onCancelCurrentRun: () => void;
  onActivateGlobalKill: () => void;
  onClearGlobalKill: () => void;
  cancelPending: boolean;
  activateKillPending: boolean;
  clearKillPending: boolean;
}) {
  const globalKillActive = killState?.globalKillActive === true;
  const running = loop.currentRun?.status === "running";
  const attentionItems: string[] = [];
  if (globalKillActive) {
    attentionItems.push(`Global kill is active${killState?.reason ? `: ${killState.reason}` : ""}. Scheduled and manual Loop execution stays blocked until cleared.`);
  }
  if (loop.currentRun?.status === "needs_user") {
    attentionItems.push("Current run is waiting for user input.");
  }
  if (loop.lastRun?.status === "failed" || loop.lastRun?.status === "budget_exceeded") {
    attentionItems.push(`Last run failed${loop.lastRun.error ? `: ${loop.lastRun.error}` : ""}.`);
  }

  return (
    <DetailSection title="Attention" testId="loop-attention-section">
      {attentionItems.length === 0 ? (
        <div className="text-[12.5px] text-text-tertiary">No attention needed right now.</div>
      ) : (
        <ul className="flex flex-col gap-1.5 text-[12.5px] text-text-secondary">
          {attentionItems.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          data-testid="loop-cancel-current-run-button"
          type="button"
          onClick={onCancelCurrentRun}
          disabled={!running || cancelPending}
          className="rounded-sm bg-bg-active px-3 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {cancelPending ? "Cancelling…" : "Cancel current run"}
        </button>
        <button
          data-testid="loop-global-kill-button"
          type="button"
          onClick={onActivateGlobalKill}
          disabled={globalKillActive || activateKillPending}
          className="rounded-sm bg-error-muted px-3 py-1.5 text-[12.5px] font-medium text-error transition-colors duration-150 hover:bg-error-muted-opaque disabled:cursor-not-allowed disabled:opacity-40"
        >
          {activateKillPending ? "Activating…" : "Activate global kill"}
        </button>
        <button
          type="button"
          onClick={onClearGlobalKill}
          disabled={!globalKillActive || clearKillPending}
          className="rounded-sm bg-bg-active px-3 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {clearKillPending ? "Clearing…" : "Clear global kill"}
        </button>
      </div>
      {globalKillActive && (
        <div data-testid="loop-global-kill-banner" className="mt-3 rounded-sm border border-error-muted bg-error-muted px-2.5 py-2 text-[12px] text-error">
          Global kill is active{killState?.reason ? `: ${killState.reason}` : ""}. Scheduled and manual Loop execution stays blocked until cleared.
        </div>
      )}
      <p className="mt-2 text-[11px] text-text-muted">
        Kill and cancel controls are guardrails around Loop scheduling/runs; normal tool permissions and HITL remain authoritative for side effects.
      </p>
    </DetailSection>
  );
}

function RecentResultsSection({
  slug,
  runs,
  isLoading,
  error,
}: {
  slug: string;
  runs: LoopRunReport[] | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  const recent = runs?.slice(0, 5) ?? [];
  return (
    <DetailSection title="Recent Results" testId="loop-recent-results-section">
      {isLoading ? (
        <div className="flex items-center gap-2 text-[12.5px] text-text-tertiary py-2">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          Loading recent results…
        </div>
      ) : error ? (
        <div className="text-[12.5px] text-error py-2">
          {error instanceof Error ? error.message : "Failed to load recent results"}
        </div>
      ) : recent.length === 0 ? (
        <div className="text-[12.5px] text-text-tertiary py-2">No run reports yet</div>
      ) : (
        <div className="flex flex-col gap-2">
          {recent.map((run) => (
            <div
              key={run.runId}
              data-testid={`loop-recent-result-${run.runId}`}
              className="rounded-md border border-border-subtle bg-bg-base px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <span className={`text-[11px] px-1.5 py-[1px] rounded font-medium ${formatRunHistoryBadgeClass(run.status)}`}>
                  {formatRunHistoryLabel(run.status)}
                </span>
                <span className="text-text-tertiary">trigger: {run.trigger}</span>
                <span className="text-text-tertiary">started: {formatDateTime(run.startedAt)}</span>
              </div>
              <LinkedRunResources slug={slug} run={run} label="resources" compact />
              {run.summary && <p className="mt-1 text-[12.5px] text-text-secondary">summary: {run.summary}</p>}
              {run.error && <p className="mt-1 text-[12.5px] text-error">error: {run.error}</p>}
              {run.skippedReason && <p className="mt-1 text-[12.5px] text-warning">skipped: {run.skippedReason}</p>}
            </div>
          ))}
        </div>
      )}
    </DetailSection>
  );
}

// ─── Advanced Debug ───
// Everything below this marker is diagnostic-only and collapsed by default.
// The source-scanning guardrail treats the first literal "Advanced Debug" as
// the boundary: forbidden labels (mode, toolProfileId, extraTools, approvalPolicy,
// collisionTargets, cleanupPolicy, dedupeKey, subjectKey, branchKey,
// triggerHealth, queue, job) are allowed only after this marker.
function AdvancedDebugSection({
  open,
  onToggle,
  slug,
  loop,
  runs,
  runsLoading,
  runsError,
  loopState,
  stateLoading,
  stateError,
  budget,
  budgetLoading,
  collisions,
  collisionsLoading,
  integrations,
  integrationsLoading,
}: {
  open: boolean;
  onToggle: () => void;
  slug: string;
  loop: LoopState;
  runs: LoopRunReport[] | undefined;
  runsLoading: boolean;
  runsError: unknown;
  loopState: { markdown?: string; state: LoopState } | undefined;
  stateLoading: boolean;
  stateError: unknown;
  budget: LoopBudgetSnapshot | null;
  budgetLoading: boolean;
  collisions: LoopCollisionSnapshot | undefined;
  collisionsLoading: boolean;
  integrations: LoopIntegrationStatusSnapshot | undefined;
  integrationsLoading: boolean;
}) {
  return (
    <section data-testid="loop-advanced-debug-section" className="rounded-lg border border-border-default bg-bg-surface p-4 shadow-sm">
      <button
        type="button"
        data-testid="loop-advanced-debug-toggle"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center justify-between text-left"
      >
        <h2 className="text-[15px] font-semibold text-text-primary">Advanced Debug</h2>
        <span className="flex items-center gap-1 text-[12.5px] text-text-muted">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>{open ? "hide" : "show"}</span>
        </span>
      </button>
      <p className="mt-1 text-[11px] text-text-muted">
        Diagnostics only. No editable tool profile, extra tools, collision, or cleanup customization controls live here.
      </p>
      {open && (
        <div data-testid="loop-advanced-debug-content" className="mt-3 flex flex-col gap-4">
          <DebugBudgetCard budget={budget} budgetLoading={budgetLoading} />
          <DebugKillStateCard loop={loop} />
          <DebugCollisionLogCard collisions={collisions} collisionsLoading={collisionsLoading} />
          <DebugIntegrationStatusCard integrations={integrations} integrationsLoading={integrationsLoading} />
          <DebugTriggerHealthCard health={loop.triggerHealth} />
          <DebugRunHistorySection slug={slug} runs={runs} isLoading={runsLoading} error={runsError} />
          <DebugStateSection
            loop={loop}
            markdown={loopState?.markdown}
            isLoading={stateLoading}
            error={stateError}
            fallbackSummary={loopState?.state.generatedStateSummary}
          />
          <DebugRawConfigCard loop={loop} />
        </div>
      )}
    </section>
  );
}

function DebugBudgetCard({ budget, budgetLoading }: { budget: LoopBudgetSnapshot | null; budgetLoading: boolean }) {
  return (
    <div data-testid="loop-budget-card" className="rounded-md border border-border-subtle bg-bg-base p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-text-primary">Budget Snapshot</h3>
        <span className="text-[11px] text-text-muted">runtime guardrail</span>
      </div>
      {budgetLoading ? (
        <LoadingTiny label="Loading budget…" />
      ) : budget ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <FieldRow label="soft / hard ratio" value={`${formatRatio(budget.budget.softThresholdRatio)} / ${formatRatio(budget.budget.hardThresholdRatio)}`} />
          <FieldRow label="token availability" value={formatAvailability(budget.usage.totalTokens, budget.budget.maxTokensPerRun, "tokens")} />
          <FieldRow label="time availability" value={formatAvailability(budget.usage.wallClockMs, budget.budget.maxWallClockMsPerRun, "ms")} />
          <FieldRow label="daily-run availability" value={formatAvailability(budget.usage.runsToday, budget.budget.maxRunsPerDay, "runs")} />
          <FieldRow label="USD availability" value={formatUsdAvailability(budget)} />
          <FieldRow label="current usage" value={formatBudgetUsage(budget)} wide />
        </div>
      ) : (
        <div className="text-[12.5px] text-text-tertiary">
          Budget snapshot unavailable. USD availability is unknown unless pricing metadata exists.
        </div>
      )}
    </div>
  );
}

function DebugKillStateCard({ loop }: { loop: LoopState }) {
  return (
    <div className="rounded-md border border-border-subtle bg-bg-base p-3">
      <h3 className="mb-2 text-[13px] font-semibold text-text-primary">Loop Status</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        <FieldRow label="status" value={loop.status} />
        <FieldRow label="updated" value={formatDateTime(loop.updatedAt)} />
      </div>
    </div>
  );
}

function DebugCollisionLogCard({ collisions, collisionsLoading }: { collisions: LoopCollisionSnapshot | undefined; collisionsLoading: boolean }) {
  return (
    <div data-testid="loop-collision-log" className="rounded-md border border-border-subtle bg-bg-base p-3">
      <h3 className="mb-2 text-[13px] font-semibold text-text-primary">Collision Log</h3>
      {collisionsLoading ? (
        <LoadingTiny label="Loading collisions…" />
      ) : collisions ? (
        <div className="space-y-2 text-[12.5px] text-text-secondary">
          <FieldRow label="target keys" value={formatTargets(collisions.targets)} />
          <FieldRow label="active leases" value={collisions.activeLeases.map((lease) => `${lease.targetKey} held by ${lease.loopId}/${lease.runId}`).join("; ") || "none"} />
          <FieldRow label="conflicts" value={collisions.conflicts.map((conflict) => `${conflict.targetKey} conflicts with ${conflict.conflictingLease.loopId}/${conflict.conflictingLease.runId}`).join("; ") || "none"} />
        </div>
      ) : (
        <div className="text-[12.5px] text-text-tertiary">No collision snapshot yet</div>
      )}
    </div>
  );
}

function DebugIntegrationStatusCard({ integrations, integrationsLoading }: { integrations: LoopIntegrationStatusSnapshot | undefined; integrationsLoading: boolean }) {
  return (
    <div data-testid="loop-integration-status" className="rounded-md border border-border-subtle bg-bg-base p-3">
      <h3 className="mb-2 text-[13px] font-semibold text-text-primary">Integration Status</h3>
      {integrationsLoading ? (
        <LoadingTiny label="Loading integrations…" />
      ) : integrations ? (
        <div className="space-y-2">
          {integrations.statuses.length === 0 ? (
            <div className="text-[12.5px] text-text-tertiary">No integration status reported</div>
          ) : (
            integrations.statuses.map((status) => (
              <div key={status.integrationId} className="rounded-sm border border-border-subtle px-2.5 py-2 text-[12.5px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-text-primary">{status.integrationId}</span>
                  <span className={status.status === "ready" ? "text-success" : status.status === "disabled" ? "text-text-tertiary" : "text-warning"}>{status.status}</span>
                  <span className="text-text-muted">GitHub token configured: {status.status === "ready" ? "yes" : "no"}</span>
                </div>
                <div className="mt-1 text-text-tertiary">last error: {status.message ?? formatLatestIntegrationError(integrations.snapshot?.errors, status.integrationId)}</div>
                <div className="text-text-tertiary">rate-limit: {status.retryAfterMs !== undefined ? `${status.retryAfterMs}ms retry-after` : "none reported"}</div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="text-[12.5px] text-text-tertiary">Integration status unavailable</div>
      )}
    </div>
  );
}

function DebugTriggerHealthCard({ health }: { health: LoopTriggerHealth[] | undefined }) {
  return (
    <div data-testid="loop-trigger-health" className="rounded-md border border-border-subtle bg-bg-base p-3">
      <h3 className="mb-2 text-[13px] font-semibold text-text-primary">Trigger Health</h3>
      {!health || health.length === 0 ? (
        <div className="text-[12.5px] text-text-tertiary">No trigger health reported</div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {health.map((item) => (
            <FieldRow
              key={`${item.triggerKind}:${item.lastCheckedAt ?? "none"}`}
              label={item.triggerKind}
              value={formatTriggerHealth(item)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DebugRunHistorySection({
  slug,
  runs,
  isLoading,
  error,
}: {
  slug: string;
  runs: LoopRunReport[] | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  return (
    <div data-testid="loop-run-history-section" className="rounded-md border border-border-subtle bg-bg-base p-3">
      <h3 className="mb-2 text-[13px] font-semibold text-text-primary">Run History</h3>
      {isLoading ? (
        <div className="flex items-center gap-2 text-[12.5px] text-text-tertiary py-2">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          Loading run history…
        </div>
      ) : error ? (
        <div className="text-[12.5px] text-error py-2">
          {error instanceof Error ? error.message : "Failed to load run history"}
        </div>
      ) : !runs || runs.length === 0 ? (
        <div className="text-[12.5px] text-text-tertiary py-2">No run reports yet</div>
      ) : (
        <div className="flex flex-col gap-2">
          {runs.map((run) => (
            <div
              key={run.runId}
              data-testid={`loop-run-history-row-${run.runId}`}
              className="rounded-md border border-border-subtle bg-bg-base px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <span className="font-mono text-text-muted">{run.runId}</span>
                <span className="text-text-primary font-medium">{run.status}</span>
                <span className="text-text-tertiary">trigger: {run.trigger}</span>
                <span className="text-text-tertiary">reason: {run.reason ?? "none"}</span>
                <span className="text-text-tertiary">started: {formatDateTime(run.startedAt)}</span>
                <span className="text-text-tertiary">ended: {formatDateTime(run.endedAt)}</span>
              </div>
              <LinkedRunResources slug={slug} run={run} label="run resources" compact />
              <div className="mt-1 grid gap-1 text-[12px] text-text-tertiary sm:grid-cols-2">
                <span>job: {run.jobId ?? "none"}</span>
                <span>queue subject: {run.subjectKey ?? "none"}</span>
                <span>dedupe: {run.dedupeKey ?? "none"}</span>
                <span>branch: {run.branchKey ?? "none"}</span>
                <span data-testid="loop-run-worktree-status">worktree: {formatWorktree(run)}</span>
                <span>diff stats: {formatArtifacts(run.observedArtifacts)}</span>
                <span>budget: {run.budgetUsage ? formatRunBudgetUsage(run.budgetUsage) : "none"}</span>
                <span>collision targets: {formatTargets(run.collisionTargets)}</span>
                <span>collision conflicts: {run.collisionConflicts?.map((conflict) => conflict.targetKey).join(", ") || "none"}</span>
                <span>integration: {formatRunIntegrationErrors(run.integrationErrors)}</span>
              </div>
              {run.blockedReason && <p data-testid="loop-run-blocked-reason" className="mt-1 text-[12.5px] text-warning">blocked: {run.blockedReason}</p>}
              {run.cleanupState && <p className="mt-1 text-[12.5px] text-text-secondary">cleanup: {run.cleanupState}</p>}
              {run.summary && <p className="mt-1 text-[12.5px] text-text-secondary">summary: {run.summary}</p>}
              {run.error && <p className="mt-1 text-[12.5px] text-error">error: {run.error}</p>}
              {run.skippedReason && <p className="mt-1 text-[12.5px] text-warning">skipped: {run.skippedReason}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DebugStateSection({
  loop,
  markdown,
  isLoading,
  error,
  fallbackSummary,
}: {
  loop: LoopState;
  markdown: string | undefined;
  isLoading: boolean;
  error: unknown;
  fallbackSummary: string | undefined;
}) {
  const stateText = markdown && markdown.trim().length > 0
    ? markdown
    : fallbackSummary ?? loop.generatedStateSummary ?? "No generated state yet";

  return (
    <div data-testid="loop-state-section" className="rounded-md border border-border-subtle bg-bg-base p-3">
      <h3 className="mb-2 text-[13px] font-semibold text-text-primary">State</h3>
      {isLoading ? (
        <div className="flex items-center gap-2 text-[12.5px] text-text-tertiary py-2">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          Loading state…
        </div>
      ) : error ? (
        <div className="text-[12.5px] text-error py-2">
          {error instanceof Error ? error.message : "Failed to load state"}
        </div>
      ) : (
        <pre className="whitespace-pre-wrap rounded-md border border-border-subtle bg-bg-base px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
          {stateText}
        </pre>
      )}
    </div>
  );
}

function DebugRawConfigCard({ loop }: { loop: LoopState }) {
  return (
    <div data-testid="loop-raw-config-card" className="rounded-md border border-border-subtle bg-bg-base p-3">
      <h3 className="mb-2 text-[13px] font-semibold text-text-primary">Raw Config / State</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        <FieldRow label="approval policy" value={loop.config.approvalPolicy} />
        <FieldRow label="cleanup policy" value={formatCleanupPolicy(loop.config.cleanupPolicy)} />
        <FieldRow label="triggers" value={formatTriggers(loop.config.triggers)} wide />
        <FieldRow label="last scheduled" value={formatDateTime(loop.lastScheduledAt)} />
        <FieldRow label="next scheduled" value={formatDateTime(loop.nextScheduledAt)} />
        <FieldRow label="last enqueued" value={formatDateTime(loop.lastEnqueuedAt)} />
        <FieldRow label="missed count" value={String(loop.missedCount ?? 0)} />
        <FieldRow label="cleanup state" value={loop.cleanupState ?? "none"} />
      </div>
    </div>
  );
}

function LoopHitlSection({
  projections,
}: {
  projections: import("../api/types").HitlProjection[];
}) {
  return (
    <DetailSection title="HITL" testId="loop-hitl-section">
      <HitlInbox
        projections={projections}
        emptyMessage="No pending HITL for this loop"
        title="Loop HITL"
      />
    </DetailSection>
  );
}

function DetailSection({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section data-testid={testId} className="rounded-lg border border-border-default bg-bg-surface p-4 shadow-sm">
      <h2 className="text-[15px] font-semibold text-text-primary mb-3">{title}</h2>
      {children}
    </section>
  );
}

function FieldRow({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <div className="text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-0.5 text-[12.5px] text-text-secondary break-words">{value}</div>
    </div>
  );
}

function LoadingTiny({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-text-tertiary py-1">
      <Loader2 size={13} className="animate-spin" aria-hidden="true" />
      {label}
    </div>
  );
}

function LinkedRunResources({
  slug,
  run,
  label,
  compact = false,
}: {
  slug: string;
  run: LoopRunReport | undefined;
  label: string;
  compact?: boolean;
}) {
  if (!run?.sessionId && !run?.goalId) {
    return (
      <div className={`${compact ? "mt-1" : "mt-3"} text-[12.5px] text-text-tertiary`}>
        {label}: none
      </div>
    );
  }

  return (
    <div className={`${compact ? "mt-1" : "mt-3"} flex flex-wrap items-center gap-2 text-[12.5px]`}>
      <span className="text-text-muted">{label}:</span>
      {run.sessionId && (
        <Link
          className="text-accent hover:text-accent-hover underline-offset-2 hover:underline"
          to={`/projects/${slug}/sessions/${run.sessionId}`}
        >
          session {run.sessionId}
        </Link>
      )}
      {run.goalId && (
        <Link
          className="text-accent hover:text-accent-hover underline-offset-2 hover:underline"
          to={`/projects/${slug}/goals/${run.goalId}`}
        >
          goal {run.goalId}
        </Link>
      )}
    </div>
  );
}

function formatTriggers(triggers: LoopConfig["triggers"]): string {
  if (!triggers || triggers.length === 0) return "none";
  return triggers.map((trigger) => {
    const cadence = trigger.cadenceMs === undefined ? "" : ` every ${trigger.cadenceMs}ms`;
    if (trigger.kind === "on_pr") return `on_pr${cadence}${trigger.branch ? ` branch ${trigger.branch}` : ""}${trigger.baseBranch ? ` base ${trigger.baseBranch}` : ""}`;
    if (trigger.kind === "on_ci_fail") return `on_ci_fail${cadence}${trigger.workflowName ? ` workflow ${trigger.workflowName}` : ""}${trigger.checkName ? ` check ${trigger.checkName}` : ""}`;
    return `on_commit${cadence}${trigger.branch ? ` branch ${trigger.branch}` : ""}`;
  }).join("; ");
}

function formatCleanupPolicy(policy: LoopConfig["cleanupPolicy"]): string {
  if (!policy) return "none";
  return [
    `enabled ${policy.enabled}`,
    policy.action ? `action ${policy.action}` : undefined,
    policy.deleteUnchangedWorktrees ? "delete unchanged worktrees" : undefined,
    policy.preserveChangedArtifacts ? "preserve changed artifacts" : undefined,
    policy.maxPreservedWorktrees !== undefined ? `max preserved ${policy.maxPreservedWorktrees}` : undefined,
    policy.noFindingRuns !== undefined ? `no-finding runs ${policy.noFindingRuns}` : undefined,
    policy.quietDays !== undefined ? `quiet days ${policy.quietDays}` : undefined,
    policy.requiresNoPendingQueue ? "requires no pending queue" : undefined,
  ].filter(Boolean).join("; ");
}

function formatTriggerHealth(item: LoopTriggerHealth): string {
  return [
    item.status,
    item.cadenceMs !== undefined ? `${item.cadenceMs}ms cadence` : undefined,
    item.lastCheckedAt !== undefined ? `checked ${formatDateTime(item.lastCheckedAt)}` : undefined,
    item.lastSuccessAt !== undefined ? `success ${formatDateTime(item.lastSuccessAt)}` : undefined,
    item.retryAfterMs !== undefined ? `retry ${item.retryAfterMs}ms` : undefined,
    item.missedCount !== undefined ? `missed ${item.missedCount}` : undefined,
    item.lastError ? `error ${item.lastError}` : undefined,
  ].filter(Boolean).join("; ");
}

function formatWorktree(run: LoopRunReport): string {
  if (!run.worktreePath && !run.branchKey && !run.baseSha && !run.resolvedHeadSha) return "none";
  return [
    run.worktreePath ? `path ${run.worktreePath}` : undefined,
    run.branchKey ? `branch ${run.branchKey}` : undefined,
    run.baseSha ? `base ${run.baseSha}` : undefined,
    run.resolvedHeadSha ? `head ${run.resolvedHeadSha}` : undefined,
    run.missedCount !== undefined ? `missed ${run.missedCount}` : undefined,
  ].filter(Boolean).join("; ");
}

function formatArtifacts(artifacts: LoopWorktreeArtifact[] | undefined): string {
  if (!artifacts || artifacts.length === 0) return "none";
  const counts = artifacts.reduce<Record<string, number>>((acc, artifact) => {
    acc[artifact.status] = (acc[artifact.status] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).map(([status, count]) => `${status} ${count}`).join(", ");
}

function formatDateTime(value: number | undefined): string {
  if (value === undefined || value === null) return "none";
  return new Date(value).toISOString();
}

function formatMutationError(...errors: unknown[]): string | null {
  const [triggerError] = errors;
  if (triggerError instanceof ApiError && triggerError.status === 409) {
    return `Loop is already running: ${triggerError.message}`;
  }

  const error = errors.find(Boolean);
  if (!error) return null;
  return error instanceof Error ? error.message : "Loop action failed";
}

function formatRatio(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatAvailability(used: number, max: number | undefined, unit: string): string {
  if (max === undefined) return `unavailable (${used} ${unit} used)`;
  const remaining = Math.max(max - used, 0);
  return `${remaining} ${unit} remaining of ${max}; used ${used}`;
}

function formatUsdAvailability(snapshot: LoopBudgetSnapshot): string {
  const used = snapshot.usage.estimatedUsd;
  const max = snapshot.budget.maxEstimatedUsdPerRun;
  if (snapshot.usage.pricingUnavailable || used === undefined || max === undefined) {
    return "unavailable (pricing metadata missing or USD limit unset)";
  }
  return `$${Math.max(max - used, 0).toFixed(4)} remaining of $${max.toFixed(4)}; used $${used.toFixed(4)}`;
}

function formatBudgetUsage(snapshot: LoopBudgetSnapshot): string {
  return formatRunBudgetUsage(snapshot.usage);
}

function formatRunBudgetUsage(usage: NonNullable<LoopRunReport["budgetUsage"]>): string {
  const usd = usage.estimatedUsd === undefined ? "USD unavailable" : `$${usage.estimatedUsd.toFixed(4)}`;
  return `${usage.iterations} iterations; ${usage.totalTokens} tokens (${usage.inputTokens} in / ${usage.outputTokens} out); ${usage.wallClockMs}ms; ${usage.runsToday} runs today; ${usd}`;
}

function formatTargets(targets: LoopRunReport["collisionTargets"]): string {
  if (!targets || targets.length === 0) return "none";
  return targets.map(formatTarget).join(", ");
}

function formatTarget(target: NonNullable<LoopRunReport["collisionTargets"]>[number]): string {
  switch (target.type) {
    case "pr":
      return `github:${target.owner}/${target.repo}:pr:${target.number}`;
    case "issue":
      return `github:${target.owner}/${target.repo}:issue:${target.number}`;
    case "branch":
      return `git:${target.owner}/${target.repo}:branch:${target.branch}`;
    case "file":
      return `file:${target.path}`;
  }
}

function formatRunIntegrationErrors(errors: LoopRunReport["integrationErrors"]): string {
  if (!errors || errors.length === 0) return "none";
  return errors.map((error) => `${error.integrationId} ${error.reason}: ${error.message}`).join("; ");
}

function formatLatestIntegrationError(errors: LoopIntegrationError[] | undefined, integrationId: string): string {
  const latest = errors?.filter((error) => error.integrationId === integrationId).at(-1);
  return latest ? `${latest.reason}: ${latest.message}` : "none";
}

function integrationSnapshotFromLoop(loop: LoopState): LoopIntegrationStatusSnapshot | undefined {
  if (!loop.latestIntegrations) return undefined;
  return {
    statuses: [],
    snapshot: loop.latestIntegrations,
    updatedAt: loop.latestIntegrations.updatedAt,
  };
}

function isHardBudgetBlocked(snapshot: LoopBudgetSnapshot | null | undefined, loop: LoopState): boolean {
  if (loop.status !== "paused" || loop.lastRun?.reason !== "hard_budget_exceeded") return false;
  if (!snapshot) return true;
  const hardRatio = snapshot.budget.hardThresholdRatio;
  const maxTokens = snapshot.budget.maxTokensPerRun;
  if (maxTokens !== undefined && snapshot.usage.totalTokens >= maxTokens * hardRatio) return true;
  const maxTime = snapshot.budget.maxWallClockMsPerRun;
  if (maxTime !== undefined && snapshot.usage.wallClockMs >= maxTime * hardRatio) return true;
  const maxRuns = snapshot.budget.maxRunsPerDay;
  if (maxRuns !== undefined && snapshot.usage.runsToday >= maxRuns * hardRatio) return true;
  return loop.lastRun?.reason === "hard_budget_exceeded";
}
