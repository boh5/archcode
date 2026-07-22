import { useEffect, useState } from "react";
import type { RecoveryNoticePart } from "@archcode/protocol";
import { StatusGlyph } from "../primitives/StatusGlyph";
import { useStatusTransition } from "../primitives/useStatusTransition";
import {
  STATUS_SUBTLE_CLASS,
  STATUS_TONE_CLASS,
  type StatusTone,
  type VisualStatusKind,
} from "../../lib/status-visuals";

const STATUS_LABEL: Readonly<Record<RecoveryNoticePart["status"], string>> = {
  scheduled: "Scheduled retry",
  retrying: "Retrying",
  recovered: "Recovered",
  failed: "Recovery failed",
};

function recoveryVisual(status: RecoveryNoticePart["status"]): {
  kind: VisualStatusKind;
  tone: StatusTone;
} {
  if (status === "scheduled") return { kind: "pending", tone: "warning" };
  if (status === "retrying") return { kind: "loading", tone: "warning" };
  if (status === "recovered") return { kind: "completed", tone: "success" };
  return { kind: "failed", tone: "error" };
}

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
  const visual = recoveryVisual(part.status);
  const statusTransition = useStatusTransition(part.id, visual.kind);
  const countdown = useCountdown(part.status === "scheduled" ? part.nextRetryAt : undefined);

  return (
    <div className="shrink-0 overflow-hidden rounded-md border border-border-subtle bg-bg-elevated">
      <div className="flex items-center gap-2 px-3 py-2">
        <span
          className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-sm ${STATUS_SUBTLE_CLASS[visual.tone]}`}
          data-recovery-visual-kind={visual.kind}
        >
          <StatusGlyph kind={visual.kind} tone={visual.tone} size={11} transition={statusTransition} />
        </span>
        <span className={`text-[12px] font-semibold ${STATUS_TONE_CLASS[visual.tone]}`}>
          {STATUS_LABEL[part.status]}
        </span>
        {part.attempt > 0 && (
          <span className="text-[11px] text-text-tertiary">
            attempt {part.attempt}
          </span>
        )}
        {part.errorKind && (
          <span className="font-mono text-[11px] text-text-tertiary">
            {part.errorKind}
          </span>
        )}
        {part.statusCode != null && (
          <span className="rounded-sm bg-bg-active px-1 py-1 font-mono text-[11px] text-text-tertiary">
            {part.statusCode}
          </span>
        )}
        {countdown !== null && (
          <span className="text-[11px] text-text-tertiary">
            retry in {countdown}
          </span>
        )}
      </div>
      {part.message && (
        <div className="border-t border-border-subtle px-3 py-2 text-[12px] text-text-secondary">
          {part.message}
        </div>
      )}
    </div>
  );
}
