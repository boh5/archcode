import { z } from "zod";
import { providersConfigSchema, modelCallOptionsSchema } from "./provider";
import { mcpConfigSchema } from "./mcp";
import { expandEnvVars } from "./env";

export const GITHUB_API_BASE_URL = "https://api.github.com" as const;

const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export const githubIntegrationConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    tokenEnv: z.string().min(1).optional(),
    apiBaseUrl: z.literal(GITHUB_API_BASE_URL).optional(),
    defaultOwner: z.string().min(1).optional(),
    defaultRepo: z.string().min(1).optional(),
  })
  .strict();

export const integrationsConfigSchema = z
  .object({
    github: githubIntegrationConfigSchema.optional(),
  })
  .strict();

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
    integrations: integrationsConfigSchema.optional(),
    agents: z.strictObject({
      orchestrator: agentConfigSchema,
      plan: agentConfigSchema,
      build: agentConfigSchema,
      reviewer: agentConfigSchema,
      explore: agentConfigSchema,
      librarian: agentConfigSchema,
    }),
    memory: memoryExtractionConfigSchema,
  })
  .strict();

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type GithubIntegrationConfig = z.infer<typeof githubIntegrationConfigSchema>;
export type IntegrationsConfig = z.infer<typeof integrationsConfigSchema>;
export type MemoryExtractionConfig = NonNullable<z.infer<typeof memoryExtractionConfigSchema>>;
export type ArchCodeConfig = z.infer<typeof archcodeConfigSchema>;

export interface ResolvedGithubIntegrationConfig {
  readonly enabled: boolean;
  readonly apiBaseUrl: typeof GITHUB_API_BASE_URL;
  readonly token?: string;
  readonly tokenSource?: string;
  readonly defaultOwner?: string;
  readonly defaultRepo?: string;
}

export class GithubIntegrationTokenError extends Error {
  constructor(public readonly attemptedEnvNames: string[]) {
    super(
      `Missing GitHub token. Set integrations.github.tokenEnv, GITHUB_TOKEN, or GH_TOKEN. Attempted env names: ${attemptedEnvNames.join(", ")}`,
    );
    this.name = "GithubIntegrationTokenError";
  }
}

export function resolveGithubIntegrationConfig(
  config?: GithubIntegrationConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedGithubIntegrationConfig {
  const enabled = config?.enabled ?? false;
  const apiBaseUrl = config?.apiBaseUrl ?? GITHUB_API_BASE_URL;
  const attemptedEnvNames: string[] = [];

  if (config?.tokenEnv) {
    const expandedTokenEnv = expandEnvVars(config.tokenEnv, "integrations.github.tokenEnv", { env });
    const hasEnvExpression = config.tokenEnv.includes("${");

    if (hasEnvExpression && expandedTokenEnv !== "") {
      const tokenFromExpandedEnvName = env[expandedTokenEnv];
      if (tokenFromExpandedEnvName !== undefined && tokenFromExpandedEnvName !== "") {
        return {
          enabled,
          apiBaseUrl,
          token: tokenFromExpandedEnvName,
          tokenSource: expandedTokenEnv,
          defaultOwner: config.defaultOwner,
          defaultRepo: config.defaultRepo,
        };
      }

      if (ENV_NAME_PATTERN.test(expandedTokenEnv)) {
        attemptedEnvNames.push(expandedTokenEnv);
      } else {
        return {
          enabled,
          apiBaseUrl,
          token: expandedTokenEnv,
          tokenSource: "integrations.github.tokenEnv",
          defaultOwner: config.defaultOwner,
          defaultRepo: config.defaultRepo,
        };
      }
    }

    if (!hasEnvExpression) {
      attemptedEnvNames.push(expandedTokenEnv);
      const token = env[expandedTokenEnv];
      if (token !== undefined && token !== "") {
        return {
          enabled,
          apiBaseUrl,
          token,
          tokenSource: expandedTokenEnv,
          defaultOwner: config.defaultOwner,
          defaultRepo: config.defaultRepo,
        };
      }
    }
  }

  const candidateEnvNames = ["GITHUB_TOKEN", "GH_TOKEN"];

  for (const envName of candidateEnvNames) {
    attemptedEnvNames.push(envName);
    const token = env[envName];
    if (token !== undefined && token !== "") {
      return {
        enabled,
        apiBaseUrl,
        token,
        tokenSource: envName,
        defaultOwner: config?.defaultOwner,
        defaultRepo: config?.defaultRepo,
      };
    }
  }

  if (enabled) {
    throw new GithubIntegrationTokenError(attemptedEnvNames);
  }

  return {
    enabled,
    apiBaseUrl,
    defaultOwner: config?.defaultOwner,
    defaultRepo: config?.defaultRepo,
  };
}
