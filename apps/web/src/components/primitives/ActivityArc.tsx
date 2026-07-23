import type { StatusTone } from "../../lib/status-visuals";
import { STATUS_TONE_CLASS } from "../../lib/status-visuals";

export function ActivityArc({
  size = 14,
  tone = "signal",
  label,
}: {
  size?: number;
  tone?: StatusTone;
  label?: string;
}) {
  return (
    <span
      className={`inline-grid shrink-0 place-items-center ${STATUS_TONE_CLASS[tone]}`}
      data-motion="loop"
      data-tone={tone}
      data-testid="activity-arc"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 14 14" width={size} height={size} fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="5.25" stroke="var(--border-default)" strokeWidth="1.5" />
        <circle
          className="animate-activity origin-center"
          cx="7"
          cy="7"
          r="5.25"
          stroke="currentColor"
          strokeDasharray="9.2 23.8"
          strokeLinecap="round"
          strokeWidth="1.5"
        />
      </svg>
    </span>
  );
}
