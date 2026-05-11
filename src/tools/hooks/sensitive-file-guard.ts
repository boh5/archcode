import path from "node:path";
import type { GuardHook, GuardDecision, ToolExecutionContext } from "../types";

export const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env$/,
  /^\.env\..+$/,
  /.*\.pem$/,
  /.*\.key$/,
  /.*\.p12$/,
  /^id_rsa.*$/,
  /^id_ed25519.*$/,
  /^\.gitconfig$/,
  /^\.bashrc$/,
  /^\.zshrc$/,
  /^\.npmrc$/,
];

export function isSensitiveFile(basename: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(basename));
}

export function createSensitiveFileGuard(): GuardHook {
  return (input: unknown, _ctx: ToolExecutionContext): GuardDecision => {
    const inputRecord = input as { path: string };
    const basename = path.basename(inputRecord.path);

    if (isSensitiveFile(basename)) {
      return {
        outcome: "ask",
        reason: `File "${basename}" is a sensitive file.`,
        prompt: `Are you sure you want to access "${inputRecord.path}"? This file may contain secrets or credentials.`,
      };
    }

    return { outcome: "allow" };
  };
}
