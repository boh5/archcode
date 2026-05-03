import { z } from "zod";
import { providersConfigSchema } from "./provider.js";

export const specraConfigSchema = z
  .object({
    $schema: z.string().optional(),
    provider: providersConfigSchema,
  })
  .strict();

export type SpecraConfig = z.infer<typeof specraConfigSchema>;
