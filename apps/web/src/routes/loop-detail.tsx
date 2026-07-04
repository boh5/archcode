import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Loader2, Pause, Play, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { ApiError } from "../api/client";
import { useLoop, useLoopRuns, useLoopState } from "../api/queries";
import { usePauseLoop, useResumeLoop, useTriggerLoop } from "../api/mutations";
import type { LoopConfig, LoopRunReport, LoopScheduleSpec, LoopState, LoopStatus } from "../api/types";

const STATUS_BADGE_CLASS: Record<LoopStatus, string> = {
  active: "bg-success-muted text-success",
  paused: "bg-warning-muted text-warning",
  disabled: "bg-bg-active text-text-muted",
  error: "bg-error-muted text-error",
};

export function LoopDetailRoute() {
  const { slug = "", loopId = "" } = useParams<{ slug: string; loopId: string }>();
  const { data: loop, isLoading: loopLoading, error: loopError } = useLoop(slug, loopId);
  const { data: runs, isLoading: runsLoading, error: runsError } = useLoopRuns(slug, loopId);
  const { data: loopState, isLoading: stateLoading, error: stateError } = useLoopState(slug, loopId);
  const triggerLoop = useTriggerLoop();
  const pauseLoop = usePauseLoop();
  const resumeLoop = useResumeLoop();
  const mutationError = formatMutationError(triggerLoop.error, pauseLoop.error, resumeLoop.error);

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

  const handlePause = () => {
    pauseLoop.mutate({ slug, loopId });
  };

  const handleResume = () => {
    resumeLoop.mutate({ slug, loopId });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-4 h-12 border-b border-border-subtle shrink-0 bg-bg-surface">
        <Link
          to={`/projects/${slug}/loops`}
          className="flex items-center gap-1 text-text-tertiary hover:text-text-primary transition-colors duration-150 cursor-pointer text-[12.5px]"
        >
          <ArrowLeft size={14} />
          Loops
        </Link>
        <span className="text-text-muted">/</span>
        <span className="font-semibold text-sm text-text-primary truncate">{loop.config.title}</span>
        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            onClick={handleTrigger}
            disabled={triggerLoop.isPending}
            className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-[12.5px] font-medium text-bg-base transition-colors duration-150 hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Play size={13} />
            {triggerLoop.isPending ? "Triggering…" : "Trigger manual run"}
          </button>
          <button
            type="button"
            onClick={handlePause}
            disabled={pauseLoop.isPending}
            className="inline-flex items-center gap-1.5 rounded-sm bg-bg-active px-3 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Pause size={13} />
            {pauseLoop.isPending ? "Pausing…" : "Pause"}
          </button>
          <button
            type="button"
            onClick={handleResume}
            disabled={resumeLoop.isPending}
            className="inline-flex items-center gap-1.5 rounded-sm bg-bg-active px-3 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RotateCcw size={13} />
            {resumeLoop.isPending ? "Resuming…" : "Resume"}
          </button>
          <span
            data-testid="loop-status-badge"
            className={`text-[11px] px-2 py-0.5 rounded-sm font-medium ${STATUS_BADGE_CLASS[loop.status]}`}
          >
            {loop.status}
          </span>
        </div>
      </div>

      {mutationError && (
        <div className="border-b border-border-subtle bg-error-muted px-4 py-2 text-xs text-error" role="alert">
          {mutationError}
        </div>
      )}

      <div className="flex-1 overflow-y-auto bg-bg-base">
        <div className="max-w-5xl mx-auto w-full px-4 py-4 flex flex-col gap-4">
          <ConfigSection loop={loop} />
          <LiveStatusSection slug={slug} loop={loop} />
          <RunHistorySection slug={slug} runs={runs} isLoading={runsLoading} error={runsError} />
          <StateSection
            loop={loop}
            markdown={loopState?.markdown}
            isLoading={stateLoading}
            error={stateError}
            fallbackSummary={loopState?.state.generatedStateSummary}
          />
        </div>
      </div>
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

function ConfigSection({ loop }: { loop: LoopState }) {
  const { config } = loop;

  return (
    <DetailSection title="Config" testId="loop-config-section">
      <div className="grid gap-2 sm:grid-cols-2">
        <FieldRow label="schedule" value={formatSchedule(config.schedule)} />
        <FieldRow label="run kind" value={config.runKind} />
        <FieldRow label="mode" value={config.mode} />
        <FieldRow label="approval policy" value={config.approvalPolicy} />
        <FieldRow label="max iterations" value={String(config.limits.maxIterationsPerRun)} />
        <FieldRow label="task prompt" value={config.taskPrompt ?? "No task prompt configured"} wide />
        <FieldRow label="goal template" value={formatGoalTemplate(config)} wide />
      </div>
    </DetailSection>
  );
}

function LiveStatusSection({ slug, loop }: { slug: string; loop: LoopState }) {
  return (
    <DetailSection title="Live Status" testId="loop-live-status-section">
      <div className="grid gap-2 sm:grid-cols-2">
        <FieldRow label="status" value={loop.status} />
        <FieldRow label="run count" value={String(loop.runCount)} />
        <FieldRow label="current run" value={formatRunSummary(loop.currentRun)} />
        <FieldRow label="last run" value={formatRunSummary(loop.lastRun)} />
        <FieldRow label="next run" value={formatDateTime(loop.nextRunAt)} />
        <FieldRow label="updated" value={formatDateTime(loop.updatedAt)} />
      </div>
      <LinkedRunResources slug={slug} run={loop.currentRun} label="current linked resources" />
      <LinkedRunResources slug={slug} run={loop.lastRun} label="last linked resources" />
    </DetailSection>
  );
}

function RunHistorySection({
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
    <DetailSection title="Run History" testId="loop-run-history-section">
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
            <div key={run.runId} className="rounded-md border border-border-subtle bg-bg-base px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <span className="font-mono text-text-muted">{run.runId}</span>
                <span className="text-text-primary font-medium">{run.status}</span>
                <span className="text-text-tertiary">trigger: {run.trigger}</span>
                <span className="text-text-tertiary">started: {formatDateTime(run.startedAt)}</span>
                <span className="text-text-tertiary">ended: {formatDateTime(run.endedAt)}</span>
              </div>
              <LinkedRunResources slug={slug} run={run} label="run resources" compact />
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

function StateSection({
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
    <DetailSection title="State" testId="loop-state-section">
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

function formatSchedule(schedule: LoopScheduleSpec): string {
  if (schedule.kind === "manual") return "manual";
  return `interval ${schedule.everyMs}ms`;
}

function formatGoalTemplate(config: LoopConfig): string {
  const template = config.goalTemplate;
  if (!template) return "none";

  const approvalPoints = template.approvalPoints.length > 0
    ? template.approvalPoints.join(", ")
    : "none";

  return `${template.title} by ${template.author}; reviewer ${template.reviewerAgent}; ${template.doneConditions.length} done conditions; approval points ${approvalPoints}`;
}

function formatRunSummary(run: LoopRunReport | undefined): string {
  if (!run) return "none";
  return `${run.runId} ${run.status} ${run.trigger} started ${formatDateTime(run.startedAt)}`;
}

function formatDateTime(value: number | undefined): string {
  if (value === undefined || value === null) return "none";
  return new Date(value).toISOString();
}

function formatMutationError(triggerError: unknown, pauseError: unknown, resumeError: unknown): string | null {
  if (triggerError instanceof ApiError && triggerError.status === 409) {
    return `Loop is already running: ${triggerError.message}`;
  }

  const error = triggerError ?? pauseError ?? resumeError;
  if (!error) return null;
  return error instanceof Error ? error.message : "Loop action failed";
}
