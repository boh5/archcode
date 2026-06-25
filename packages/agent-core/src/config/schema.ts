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

export const memoryExtractionConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  minMessages: z.number().int().min(1).default(5),
  minContentLength: z.number().int().min(100).default(1000),
  cooldownMs: z.number().int().min(0).default(300_000),
}).optional();

export const archcodeConfigSchema = z
  .object({
    $schema: z.string().optional(),
    provider: providersConfigSchema,
    mcp: mcpConfigSchema.optional(),
    agents: z.record(z.string(), agentConfigSchema).optional(),
    memory: memoryExtractionConfigSchema,
  })
  .strict();

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type MemoryExtractionConfig = NonNullable<z.infer<typeof memoryExtractionConfigSchema>>;
export type ArchCodeConfig = z.infer<typeof archcodeConfigSchema>;
