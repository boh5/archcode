import { useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { useLoops } from "../api/queries";
import { CreateLoopDialog } from "../components/features/CreateLoopDialog";
import type { LoopState, LoopStatus } from "../api/types";

const STATUS_BADGE_CLASS: Record<LoopStatus, string> = {
  active: "bg-success-muted text-success",
  paused: "bg-warning-muted text-warning",
  disabled: "bg-bg-active text-text-muted",
  error: "bg-error-muted text-error",
};

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
  return `interval ${schedule.everyMs}ms`;
}

function formatLastRun(loop: LoopState): string {
  if (!loop.lastRun) return "none";
  const status = loop.lastRun.status;
  const time = new Date(loop.lastRun.startedAt).toLocaleString();
  return `${status} ${time}`;
}

function formatNextRun(loop: LoopState): string | null {
  if (loop.nextRunAt === undefined || loop.nextRunAt === null) return null;
  return new Date(loop.nextRunAt).toLocaleString();
}

function LoopListItem({ loop }: { loop: LoopState }) {
  const nextRun = formatNextRun(loop);
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-text-primary truncate">
          {loop.config.title}
        </div>
        <div className="flex items-center gap-2 mt-1 text-[11px] text-text-muted">
          <span className="font-mono">{loop.loopId.slice(0, 8)}</span>
          <span>schedule: {formatSchedule(loop)}</span>
          <span>runKind: {loop.config.runKind}</span>
          <span>mode: {loop.config.mode}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-text-muted">
          <span>last run: {formatLastRun(loop)}</span>
          {nextRun && <span>next: {nextRun}</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className={`text-[11px] px-2 py-0.5 rounded-sm font-medium ${STATUS_BADGE_CLASS[loop.status]}`}>
          {loop.status}
        </span>
      </div>
    </div>
  );
}