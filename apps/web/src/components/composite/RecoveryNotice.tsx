import type { RecoveryNoticePart } from "@archcode/protocol";
import { StatusGlyph } from "../primitives/StatusGlyph";
import { useCountdown } from "../primitives/TemporalText";
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

// ─── RecoveryNotice ───

export interface RecoveryNoticeProps {
  part: RecoveryNoticePart;
}

export function RecoveryNotice({ part }: RecoveryNoticeProps) {
  const visual = recoveryVisual(part.status);
  const statusTransition = useStatusTransition(part.id, visual.kind);
  const countdown = useCountdown(part.nextRetryAt, part.status === "scheduled");

  return (
    <div className="mx-1.5 my-0.5 shrink-0 overflow-hidden rounded-[6px] border border-border-default bg-bg-elevated">
      <div className="flex items-center gap-2 px-2.5 py-2">
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
        <div className="border-t border-border-subtle px-2.5 py-2 text-[12px] leading-[1.45] text-text-secondary">
          {part.message}
        </div>
      )}
    </div>
  );
}
