import type { AutomationTrigger } from "../api/types";

export function formatAutomationTrigger(trigger: AutomationTrigger): string {
  if (trigger.kind === "once") {
    return `Once · ${new Date(trigger.at).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }
  if (trigger.kind === "interval") {
    const { value, unit } = readableInterval(trigger.everyMs);
    return `Every ${value} ${unit}${value === 1 ? "" : "s"}`;
  }
  return `${trigger.expression} · ${trigger.timezone}`;
}

function readableInterval(everyMs: number): { value: number; unit: "second" | "minute" | "hour" } {
  if (everyMs % 3_600_000 === 0) return { value: everyMs / 3_600_000, unit: "hour" };
  if (everyMs % 60_000 === 0) return { value: everyMs / 60_000, unit: "minute" };
  return { value: everyMs / 1_000, unit: "second" };
}

export function formatAutomationScheduleTime(timestamp: string, now = Date.now()): string {
  const target = new Date(timestamp);
  const current = new Date(now);
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const currentDay = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const dayDifference = Math.round((targetDay - currentDay) / 86_400_000);
  const time = target.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (dayDifference === 0) return `Today, ${time}`;
  if (dayDifference === 1) return `Tomorrow, ${time}`;
  if (dayDifference > 1 && dayDifference < 7) {
    return `${target.toLocaleDateString([], { weekday: "long" })}, ${time}`;
  }
  return target.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
