export interface CronAdapterHandle {
  readonly id?: unknown;
}

export interface CronValidationResult {
  readonly valid: boolean;
  readonly nextFireAt?: number;
  readonly error?: string;
}

export interface CronAdapter {
  validate(expression: string, relativeToMs?: number): CronValidationResult;
  nextFire(expression: string, relativeToMs: number): number | undefined;
  schedule(expression: string, callback: (scheduledAt: number) => void | Promise<void>): CronAdapterHandle;
  cancel(handle: CronAdapterHandle): void;
}

export class BunCronAdapter implements CronAdapter {
  validate(expression: string, relativeToMs: number = Date.now()): CronValidationResult {
    const fieldError = validateFiveFieldExpression(expression);
    if (fieldError !== undefined) return { valid: false, error: fieldError };

    try {
      const next = Bun.cron.parse(expression, new Date(relativeToMs));
      if (next === null) {
        return { valid: false, error: `Cron expression has no future UTC occurrence: ${expression}` };
      }
      return { valid: true, nextFireAt: next.getTime() };
    } catch (error) {
      return { valid: false, error: errorToMessage(error) };
    }
  }

  nextFire(expression: string, relativeToMs: number): number | undefined {
    try {
      return Bun.cron.parse(expression, new Date(relativeToMs))?.getTime();
    } catch {
      return undefined;
    }
  }

  schedule(expression: string, callback: (scheduledAt: number) => void | Promise<void>): CronAdapterHandle {
    const job = Bun.cron(expression, function () {
      return runBunCronCallback(arguments[0], callback);
    });
    job.unref();
    return { id: job };
  }

  cancel(handle: CronAdapterHandle): void {
    if (isCronJob(handle.id)) handle.id.stop();
  }
}

export class FakeCronAdapter implements CronAdapter {
  readonly #handles = new Map<number, { expression: string; callback: (scheduledAt: number) => void | Promise<void> }>();
  #nextId = 1;

  validate(expression: string, relativeToMs: number = Date.now()): CronValidationResult {
    return new BunCronAdapter().validate(expression, relativeToMs);
  }

  nextFire(expression: string, relativeToMs: number): number | undefined {
    return new BunCronAdapter().nextFire(expression, relativeToMs);
  }

  schedule(expression: string, callback: (scheduledAt: number) => void | Promise<void>): CronAdapterHandle {
    const id = this.#nextId++;
    this.#handles.set(id, { expression, callback });
    return { id };
  }

  cancel(handle: CronAdapterHandle): void {
    if (typeof handle.id === "number") this.#handles.delete(handle.id);
  }

  async fire(handle: CronAdapterHandle, scheduledAt: number): Promise<void> {
    if (typeof handle.id !== "number") throw new Error("Fake cron handle id must be numeric.");
    const entry = this.#handles.get(handle.id);
    if (entry === undefined) throw new Error(`No fake cron handle registered for id ${handle.id}`);
    await entry.callback(scheduledAt);
  }

  handles(): CronAdapterHandle[] {
    return Array.from(this.#handles.keys()).map((id) => ({ id }));
  }

  size(): number {
    return this.#handles.size;
  }
}

export function runBunCronCallbackForTest(controller: unknown, callback: (scheduledAt: number) => void | Promise<void>): Promise<void> {
  return runBunCronCallback(controller, callback);
}

function validateFiveFieldExpression(expression: string): string | undefined {
  const fieldCount = expression.trim().split(/\s+/).filter(Boolean).length;
  if (fieldCount !== 5) return "Cron expressions must use exactly 5 UTC fields; seconds are not supported.";
  return undefined;
}

function isCronJob(value: unknown): value is { stop(): unknown } {
  return value !== null && typeof value === "object" && "stop" in value && typeof value.stop === "function";
}

function scheduledTimeFromController(controller: unknown): number {
  if (controller !== null && typeof controller === "object" && "scheduledTime" in controller && typeof controller.scheduledTime === "number") {
    return controller.scheduledTime;
  }
  throw new Error("Bun cron handler did not provide a scheduledTime controller.");
}

async function runBunCronCallback(controller: unknown, callback: (scheduledAt: number) => void | Promise<void>): Promise<void> {
  try {
    await callback(scheduledTimeFromController(controller));
  } catch {
    // Cron callback failures are recorded by the scheduler health path and must not escape to Bun as unhandled rejections.
  }
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
