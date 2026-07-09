import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { useLoops } from "../api/queries";
import { CreateLoopDialog } from "../components/features/CreateLoopDialog";
import type { LoopState, LoopRunReportStatus } from "../api/types";

// Four primary user-facing states for Loop primary surfaces.
type PrimaryLoopState = "Running" | "Awaiting Input" | "Completed" | "Failed";

const PRIMARY_STATE_BADGE_CLASS: Record<PrimaryLoopState, string> = {
  "Running": "bg-success-muted text-success",
  "Awaiting Input": "bg-warning-muted text-warning",
  "Completed": "bg-accent-muted text-accent",
  "Failed": "bg-error-muted text-error",
};

function mapRunStatusToPrimary(status: LoopRunReportStatus): PrimaryLoopState {
  switch (status) {
    case "running":
      return "Running";
    case "succeeded":
      return "Completed";
    case "failed":
    case "budget_exceeded":
      return "Failed";
    case "needs_user":
      return "Awaiting Input";
    default:
      // skipped, cancelled → finished without failure
      return "Completed";
  }
}

function mapToPrimaryState(loop: LoopState): PrimaryLoopState {
  const currentJob = loop.currentJob;
  const currentRun = loop.currentRun;

  // Awaiting Input: blocked or needs user attention
  if (
    currentJob?.status === "blocked" ||
    currentJob?.status === "needs_user" ||
    currentRun?.status === "needs_user"
  ) {
    return "Awaiting Input";
  }

  // Running: active current run or job
  if (currentRun?.status === "running" || currentJob?.status === "running") {
    return "Running";
  }

  // Failed: loop error or last run failed
  if (loop.status === "error" || loop.lastRun?.status === "failed" || loop.lastRun?.status === "budget_exceeded") {
    return "Failed";
  }

  // Completed: last run succeeded
  if (loop.lastRun?.status === "succeeded") {
    return "Completed";
  }

  // Default: active with no run history → Running (ready/idle)
  // Paused/disabled with no run history → Completed (idle)
  return loop.status === "active" ? "Running" : "Completed";
}

export function LoopsRoute() {
  const { slug = "" } = useParams<{ slug: string }>();
  const { data: loops, isLoading, error } = useLoops(slug);
  const [createOpen, setCreateOpen] = useState(false);

  const handleCreated = (_loopId: string) => {
    setCreateOpen(false);
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-text-secondary text-sm gap-2">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-text-muted border-t-transparent" />
        Loading loops...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-error text-sm">
        Failed to load loops
      </div>
    );
  }

  if (!loops || loops.length === 0) {
    return (
      <>
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between px-4 h-12 border-b border-border-subtle shrink-0 bg-bg-surface">
            <span className="font-semibold text-sm text-text-primary">Loops</span>
            <NewLoopButton onClick={() => setCreateOpen(true)} />
          </div>
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <h2 className="text-lg font-medium text-text-primary">No loops yet</h2>
              <p className="text-sm text-text-tertiary text-center max-w-xs">
                Create a Loop to run recurring agent work on a schedule or manually.
              </p>
              <NewLoopButton onClick={() => setCreateOpen(true)} variant="primary" />
            </div>
          </div>
        </div>
        <CreateLoopDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          slug={slug}
          onCreated={handleCreated}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between px-4 h-12 border-b border-border-subtle shrink-0 bg-bg-surface">
          <span className="font-semibold text-sm text-text-primary">Loops</span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-text-tertiary">{loops.length} total</span>
            <NewLoopButton onClick={() => setCreateOpen(true)} />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto w-full">
            {loops.map((loop) => (
              <LoopListItem key={loop.loopId} loop={loop} />
            ))}
          </div>
        </div>
      </div>
      <CreateLoopDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        slug={slug}
        onCreated={handleCreated}
      />
    </>
  );
}

function NewLoopButton({
  onClick,
  variant = "ghost",
}: {
  onClick: () => void;
  variant?: "ghost" | "primary";
}) {
  if (variant === "primary") {
    return (
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-[12.5px] font-medium text-bg-base transition-colors duration-150 hover:bg-accent-hover"
      >
        <Plus size={13} />
        New Loop
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-sm bg-bg-active px-2.5 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
    >
      <Plus size={13} />
      New Loop
    </button>
  );
}

function formatSchedule(loop: LoopState): string {
  const { schedule } = loop.config;
  if (schedule.kind === "manual") return "manual";
  if (schedule.kind === "interval") return `interval ${schedule.everyMs}ms`;
  return `cron UTC ${schedule.expression}`;
}

function formatLastRun(loop: LoopState): string {
  if (!loop.lastRun) return "none";
  const time = new Date(loop.lastRun.startedAt).toLocaleString();
  return `${mapRunStatusToPrimary(loop.lastRun.status)} ${time}`;
}

function formatNextRun(loop: LoopState): string | null {
  if (loop.nextRunAt === undefined || loop.nextRunAt === null) return null;
  return new Date(loop.nextRunAt).toLocaleString();
}

function LoopListItem({ loop }: { loop: LoopState }) {
  const { slug = "" } = useParams<{ slug: string }>();
  const nextRun = formatNextRun(loop);
  const primaryState = mapToPrimaryState(loop);
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
      <div className="flex-1 min-w-0">
        <Link
          to={`/projects/${slug}/loops/${loop.loopId}`}
          className="block text-[13px] font-medium text-text-primary truncate hover:text-accent transition-colors duration-150"
        >
          {loop.config.title}
        </Link>
        <div className="flex items-center gap-2 mt-1 text-[11px] text-text-muted">
          <span>schedule: {formatSchedule(loop)}</span>
          <span>template: {loop.config.templateId}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-text-muted">
          <span>last run: {formatLastRun(loop)}</span>
          {nextRun && <span>next: {nextRun}</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span
          data-testid="loop-primary-state"
          className={`text-[11px] px-2 py-0.5 rounded-sm font-medium ${PRIMARY_STATE_BADGE_CLASS[primaryState]}`}
        >
          {primaryState}
        </span>
      </div>
    </div>
  );
}
