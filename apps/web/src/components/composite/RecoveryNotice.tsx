import { useEffect, useState } from "react";
import type { RecoveryNoticePart } from "@specra/protocol";

// ─── Status config ───

const STATUS_CONFIG: Record<
  RecoveryNoticePart["status"],
  { icon: string; bgClass: string; textClass: string; label: string; animate?: string }
> = {
  scheduled: {
    icon: "⏳",
    bgClass: "bg-warning-muted",
    textClass: "text-warning",
    label: "Scheduled retry",
  },
  retrying: {
    icon: "⟳",
    bgClass: "bg-warning-muted",
    textClass: "text-warning",
    label: "Retrying",
    animate: "animate-spin",
  },
  recovered: {
    icon: "✓",
    bgClass: "bg-success-muted",
    textClass: "text-success",
    label: "Recovered",
  },
  failed: {
    icon: "✗",
    bgClass: "bg-error-muted",
    textClass: "text-error",
    label: "Recovery failed",
  },
};

// ─── Countdown hook ───

function useCountdown(nextRetryAt: number | undefined): string | null {
  const [remaining, setRemaining] = useState<string | null>(null);

  useEffect(() => {
    if (nextRetryAt === undefined) {
      setRemaining(null);
      return;
    }

    const compute = (): string | null => {
      const diff = nextRetryAt - Date.now();
      if (diff <= 0) return null;
      const seconds = Math.ceil(diff / 1000);
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${minutes}m ${secs}s`;
    };

    setRemaining(compute());
    const interval = setInterval(() => {
      const next = compute();
      setRemaining(next);
      if (next === null) clearInterval(interval);
    }, 1000);

    return () => clearInterval(interval);
  }, [nextRetryAt]);

  return remaining;
}

// ─── RecoveryNotice ───

export interface RecoveryNoticeProps {
  part: RecoveryNoticePart;
}

export function RecoveryNotice({ part }: RecoveryNoticeProps) {
  const config = STATUS_CONFIG[part.status];
  const countdown = useCountdown(part.status === "scheduled" ? part.nextRetryAt : undefined);

  return (
    <div className="bg-bg-overlay border border-border-subtle rounded-md overflow-hidden my-1.5 shrink-0">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <span
          className={`w-[18px] h-[18px] rounded flex items-center justify-center text-[10px] shrink-0 ${config.bgClass} ${config.textClass} ${config.animate ?? ""}`}
          aria-hidden="true"
        >
          {config.icon}
        </span>
        <span className={`text-xs font-medium ${config.textClass}`}>
          {config.label}
        </span>
        {part.attempt > 0 && (
          <span className="text-[11px] text-text-muted">
            attempt {part.attempt}
          </span>
        )}
        {part.errorKind && (
          <span className="text-[11px] text-text-muted font-mono">
            {part.errorKind}
          </span>
        )}
        {countdown !== null && (
          <span className="text-[11px] text-text-muted">
            retry in {countdown}
          </span>
        )}
      </div>
      {part.message && (
        <div className="border-t border-border-subtle px-2.5 py-1.5 text-[12px] text-text-secondary">
          {part.message}
        </div>
      )}
    </div>
  );
}