import type { AutomationTrigger } from "../api/types";

export function formatAutomationTrigger(trigger: AutomationTrigger): string {
  if (trigger.kind === "once") return `Once ${new Date(trigger.at).toLocaleString()}`;
  if (trigger.kind === "interval") return `Every ${trigger.everyMs} ms`;
  return `Cron ${trigger.expression} (${trigger.timezone})`;
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
