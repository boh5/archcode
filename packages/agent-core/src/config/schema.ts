import { z } from "zod";
import { providersConfigSchema, modelCallOptionsSchema } from "./provider";
import { mcpConfigSchema } from "./mcp";

export const agentConfigSchema = z
  .object({
    model: z.string().min(1),
    variant: z.string().optional(),
    options: modelCallOptionsSchema.optional(),
  })
  .strict();

export const specraConfigSchema = z
  .object({
    $schema: z.string().optional(),
    provider: providersConfigSchema,
    mcp: mcpConfigSchema.optional(),
    agents: z.record(z.string(), agentConfigSchema).optional(),
  })
  .strict();

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type SpecraConfig = z.infer<typeof specraConfigSchema>;
