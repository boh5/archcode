import type { StatusTone } from "../../lib/status-visuals";
import { STATUS_TONE_CLASS } from "../../lib/status-visuals";

const RADIUS = 5.25;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ProgressRing({
  percent,
  size = 14,
  tone = "neutral",
  label,
}: {
  percent: number;
  size?: number;
  tone?: StatusTone;
  label?: string;
}) {
  const normalizedPercent = Math.min(100, Math.max(0, percent));
  const dashOffset = CIRCUMFERENCE * (1 - normalizedPercent / 100);

  return (
    <span
      className={`inline-grid shrink-0 place-items-center ${STATUS_TONE_CLASS[tone]}`}
      data-percent={normalizedPercent}
      data-testid="progress-ring"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 14 14" width={size} height={size} fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r={RADIUS} stroke="var(--border-default)" strokeWidth="1.5" />
        <circle
          cx="7"
          cy="7"
          r={RADIUS}
          stroke="currentColor"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          strokeWidth="1.5"
          transform="rotate(-90 7 7)"
          style={{ transition: "stroke-dashoffset var(--motion-overlay) var(--ease-enter)" }}
        />
      </svg>
    </span>
  );
}
