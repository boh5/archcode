import type { AutomationTrigger } from "@archcode/protocol";

import { AutomationTriggerSchema } from "./schema";
import { parseCronExpression, validateCronTrigger } from "./trigger-validation";

const CRON_LIMIT_MINUTES = 5 * 366 * 24 * 60;

export function validateAutomationTrigger(trigger: AutomationTrigger): AutomationTrigger {
  return AutomationTriggerSchema.parse(trigger);
}

export function nextFireAt(trigger: AutomationTrigger, afterMs: number): string | undefined {
  const parsed = validateAutomationTrigger(trigger);
  if (parsed.kind === "once") {
    const at = Date.parse(parsed.at);
    return at > afterMs ? new Date(at).toISOString() : undefined;
  }
  if (parsed.kind === "interval") return new Date(afterMs + parsed.everyMs).toISOString();
  return nextCronFireAt(parsed.expression, parsed.timezone, afterMs);
}

export function nextCronFireAt(expression: string, timezone: string, afterMs: number): string {
  const cron = parseCronExpression(expression);
  validateCronTrigger(expression, timezone);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  let candidate = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  for (let checked = 0; checked < CRON_LIMIT_MINUTES; checked += 1, candidate += 60_000) {
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
    const dayOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "");
    const domMatches = cron.dayOfMonth.values.has(Number(parts.day));
    const dowMatches = cron.dayOfWeek.values.has(dayOfWeek);
    const dayMatches = cron.dayOfMonth.unrestricted
      ? dowMatches
      : cron.dayOfWeek.unrestricted
        ? domMatches
        : domMatches || dowMatches;
    if (
      cron.minute.values.has(Number(parts.minute))
      && cron.hour.values.has(Number(parts.hour))
      && cron.month.values.has(Number(parts.month))
      && dayMatches
    ) return new Date(candidate).toISOString();
  }
  throw new Error(`Cron expression has no occurrence in the next five years: ${expression}`);
}
