import { useEffect, useState, type HTMLAttributes } from "react";
import {
  browserTimeClock,
  type TimeClock,
  type TimeCadence,
  useClockSnapshot,
} from "../../lib/time-clock";
import {
  formatCountdown,
  formatElapsedDuration,
  formatLocalDateTime,
  formatRelativeTime,
  type RelativeTimeStyle,
} from "../../lib/time-format";

function relativeCadence(timestamp: number, now: number): TimeCadence {
  return Math.max(0, now - timestamp) < 60_000 ? "second" : "minute";
}

export interface RelativeTimePresentation {
  readonly full: string;
  readonly short: string;
}

export function useRelativeTimePresentation(
  timestamp: number,
  clock: TimeClock = browserTimeClock,
): RelativeTimePresentation {
  const [cadence, setCadence] = useState<TimeCadence>(() =>
    relativeCadence(timestamp, clock.store("second").getSnapshot())
  );
  const now = useClockSnapshot(cadence, true, clock)
    ?? clock.store(cadence).getSnapshot();
  const nextCadence = relativeCadence(timestamp, now);
  useEffect(() => {
    if (cadence !== nextCadence) setCadence(nextCadence);
  }, [cadence, nextCadence]);
  return {
    full: formatRelativeTime(timestamp, now, "full"),
    short: formatRelativeTime(timestamp, now, "short"),
  };
}

export function useRelativeTime(
  timestamp: number,
  style: RelativeTimeStyle = "full",
  clock: TimeClock = browserTimeClock,
): string {
  return useRelativeTimePresentation(timestamp, clock)[style];
}

export interface ElapsedTimeInput {
  startedAt: number;
  active: boolean;
  durationMs?: number;
  endedAt?: number;
}

export function useElapsedTime(
  input: ElapsedTimeInput,
  clock: TimeClock = browserTimeClock,
): string {
  const now = useClockSnapshot("second", input.active, clock);
  const durationMs = input.durationMs
    ?? (input.active
      ? (now ?? input.startedAt) - input.startedAt
      : (input.endedAt ?? input.startedAt) - input.startedAt);
  return formatElapsedDuration(durationMs);
}

export function useCountdown(
  targetAt: number | undefined,
  active = true,
  clock: TimeClock = browserTimeClock,
): string | null {
  const store = clock.store("second");
  const [counting, setCounting] = useState(() => active && targetAt !== undefined);
  const publishedNow = useClockSnapshot(
    "second",
    counting && active && targetAt !== undefined,
    clock,
  );
  const now = publishedNow ?? store.getSnapshot();
  const shouldCount = active && targetAt !== undefined && targetAt > now;
  useEffect(() => {
    if (counting !== shouldCount) setCounting(shouldCount);
  }, [counting, shouldCount]);
  if (targetAt === undefined || !active) return null;
  return formatCountdown(targetAt, now);
}

export interface RelativeTimeValueProps
  extends Omit<HTMLAttributes<HTMLTimeElement>, "children" | "style" | "title"> {
  timestamp: number;
  text: string;
}

export function RelativeTimeValue({
  timestamp,
  text,
  ...props
}: RelativeTimeValueProps) {
  const absolute = formatLocalDateTime(timestamp);

  return (
    <time
      {...props}
      dateTime={new Date(timestamp).toISOString()}
      title={absolute}
      aria-label={`${text}; ${absolute}`}
    >
      {text}
    </time>
  );
}

export interface RelativeTimeProps
  extends Omit<RelativeTimeValueProps, "text"> {
  style?: RelativeTimeStyle;
  clock?: TimeClock;
}

export function RelativeTime({
  timestamp,
  style = "full",
  clock = browserTimeClock,
  ...props
}: RelativeTimeProps) {
  const text = useRelativeTime(timestamp, style, clock);
  return <RelativeTimeValue {...props} timestamp={timestamp} text={text} />;
}
