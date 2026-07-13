import { BUILTIN_MCP_SERVER_NAMES } from "@archcode/protocol";
import type { ServerConfig } from "../../api/config";
import { ApiError } from "../../api/client";

export type SettingsSection = "models" | "agents" | "mcp" | "memory" | "github";
export type FieldErrors = Record<string, string>;

export const AGENT_NAMES = [
  "engineer", "goal_lead", "plan", "build", "reviewer", "explore", "librarian",
] as const;

export const BUILT_IN_MCP_NAMES = BUILTIN_MCP_SERVER_NAMES;
export const OPENAI_COMPATIBLE_PACKAGE = "@ai-sdk/openai-compatible";

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
  return { enabled: true, minMessages: 5, minContentLength: 1000, cooldownMs: 300_000 };
}
