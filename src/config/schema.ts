import { z } from "zod";
import { providersConfigSchema } from "./provider";
import { mcpConfigSchema } from "./mcp";

export const specraConfigSchema = z
  .object({
    $schema: z.string().optional(),
    provider: providersConfigSchema,
    mcp: mcpConfigSchema.optional(),
  })
  .strict();

export type SpecraConfig = z.infer<typeof specraConfigSchema>;
