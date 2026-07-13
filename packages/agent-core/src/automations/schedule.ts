import type { AutomationTrigger } from "@archcode/protocol";

import { AutomationTriggerSchema } from "./schema";

const CRON_LIMIT_MINUTES = 5 * 366 * 24 * 60;

interface CronField {
  readonly values: ReadonlySet<number>;
  readonly unrestricted: boolean;
}

interface ParsedCron {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

export function validateAutomationTrigger(trigger: AutomationTrigger): AutomationTrigger {
  const parsed = AutomationTriggerSchema.parse(trigger);
  if (parsed.kind !== "cron") return parsed;
  parseCron(parsed.expression);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: parsed.timezone }).format(0);
  } catch {
    throw new Error(`Invalid IANA timezone: ${parsed.timezone}`);
  }
  return parsed;
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
  const cron = parseCron(expression);
  validateAutomationTrigger({ kind: "cron", expression, timezone });
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

function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron expressions must use exactly 5 fields");
  return {
    minute: parseCronField(fields[0]!, 0, 59),
    hour: parseCronField(fields[1]!, 0, 23),
    dayOfMonth: parseCronField(fields[2]!, 1, 31),
    month: parseCronField(fields[3]!, 1, 12),
    dayOfWeek: parseCronField(fields[4]!, 0, 7, true),
  };
}

function parseCronField(source: string, min: number, max: number, sundayAlias = false): CronField {
  const values = new Set<number>();
  const unrestricted = source === "*";
  for (const segment of source.split(",")) {
    const [rangeSource, stepSource] = segment.split("/");
    if (segment.split("/").length > 2) throw new Error(`Invalid cron field: ${source}`);
    const step = stepSource === undefined ? 1 : parseInteger(stepSource, 1, max - min + 1, source);
    let start: number;
    let end: number;
    if (rangeSource === "*") {
      start = min;
      end = max;
    } else if (rangeSource?.includes("-")) {
      const [startSource, endSource, extra] = rangeSource.split("-");
      if (extra !== undefined) throw new Error(`Invalid cron field: ${source}`);
      start = parseInteger(startSource!, min, max, source);
      end = parseInteger(endSource!, min, max, source);
      if (end < start) throw new Error(`Invalid cron range: ${source}`);
    } else {
      start = parseInteger(rangeSource ?? "", min, max, source);
      end = start;
    }
    for (let value = start; value <= end; value += step) values.add(sundayAlias && value === 7 ? 0 : value);
  }
  if (values.size === 0) throw new Error(`Invalid cron field: ${source}`);
  return { values, unrestricted };
}

function parseInteger(source: string, min: number, max: number, field: string): number {
  if (!/^\d+$/.test(source)) throw new Error(`Invalid cron field: ${field}`);
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Cron value out of range: ${field}`);
  return value;
}
