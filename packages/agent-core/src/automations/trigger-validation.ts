const CRON_FIELD_COUNT = 5;

export interface CronField {
  readonly values: ReadonlySet<number>;
  readonly unrestricted: boolean;
}

export interface ParsedCron {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

export function validateCronTrigger(expression: string, timezone: string): void {
  parseCronExpression(expression);
  validateIanaTimezone(timezone);
}

export function validateIanaTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}

export function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_COUNT) throw new Error("Cron expressions must use exactly 5 fields");
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
