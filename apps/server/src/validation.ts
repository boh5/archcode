import type { ValidationTargets } from "hono";
import { validator } from "hono/validator";
import { z } from "zod/v4";

import { BadRequestError } from "./errors";

export function zValidator<Target extends keyof ValidationTargets, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) {
  return validator(target, (value): z.output<Schema> => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestError(
        result.error.issues[0]?.message ?? `Request ${target} is invalid`,
      );
    }
    return result.data;
  });
}
