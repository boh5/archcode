import { BUILTIN_MCP_SERVER_NAMES } from "@archcode/protocol";
import type { ServerConfig } from "../../api/config";
import { ApiError } from "../../api/client";

export type SettingsSection =
  | "config-recovery"
  | "models"
  | "profiles"
  | "security"
  | "runtime-data"
  | "mcp"
  | "skills"
  | "memory"
  | "github"
  | "updates";
export type FieldErrors = Record<string, string>;

export const PROFILE_NAMES = [
  "principal", "deep", "fast",
] as const;

export const BUILT_IN_MCP_NAMES = BUILTIN_MCP_SERVER_NAMES;

export interface MissingProfileVariant {
  profile: typeof PROFILE_NAMES[number];
  model: string;
  variant: string;
}

export function missingProfileVariant(
  config: ServerConfig,
  profile: typeof PROFILE_NAMES[number],
): MissingProfileVariant | undefined {
  const item = config.profiles[profile];
  if (item.variant === undefined) return undefined;
  const separator = item.model.indexOf(":");
  if (separator < 0) return undefined;
  const providerId = item.model.slice(0, separator);
  const modelId = item.model.slice(separator + 1);
  const model = config.provider[providerId]?.models[modelId];
  if (!model || Object.prototype.hasOwnProperty.call(model.variants ?? {}, item.variant)) {
    return undefined;
  }
  return { profile, model: item.model, variant: item.variant };
}

export function missingProfileVariants(config: ServerConfig): MissingProfileVariant[] {
  return PROFILE_NAMES.flatMap((profile) => {
    const issue = missingProfileVariant(config, profile);
    return issue === undefined ? [] : [issue];
  });
}

export function cloneConfig(config: ServerConfig): ServerConfig {
  return structuredClone(config);
}

export function hasConfigChanges(left: ServerConfig, right: ServerConfig): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

export function withDraft<T>(value: T, update: (draft: T) => void): T {
  const draft = structuredClone(value);
  update(draft);
  return draft;
}

export function toFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object") return {};
  const details = error.details as Record<string, unknown>;
  if (Array.isArray(details.issues)) {
    return Object.fromEntries(details.issues.flatMap((issue) => {
      if (!issue || typeof issue !== "object") return [];
      const item = issue as { path?: unknown; message?: unknown };
      return typeof item.path === "string" && typeof item.message === "string"
        ? [[item.path, item.message]]
        : [];
    }));
  }
  return Object.fromEntries(Object.entries(details).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function errorAtOrBelow(errors: FieldErrors, path: string): string | undefined {
  return errors[path] ?? Object.entries(errors).find(([candidate]) => candidate.startsWith(`${path}.`))?.[1];
}

export function defaultMemoryConfig() {
  return { useMemory: true, autoLearning: true };
}
