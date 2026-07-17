import path from "node:path";
import type { ToolPermission, PermissionDecision, ToolExecutionContext } from "../types";

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

export interface SensitivePathFacts {
  bashCredential: boolean;
  fileToolSensitive: boolean;
}

const BASH_CREDENTIAL_BASENAME = /^(?:\.npmrc|\.pypirc|\.netrc|.*\.(?:pem|key|p12)|id_(?:rsa|dsa|ecdsa|ed25519).*)$/;

export function classifySensitivePath(input: {
  inputBasename: string;
  effectiveCanonicalPath: string;
}): SensitivePathFacts {
  const basename = path.basename(input.effectiveCanonicalPath);
  const template = [".env.example", ".env.sample", ".env.template"].includes(basename);
  const components = input.effectiveCanonicalPath.split(path.sep).filter(Boolean);
  const componentPath = `/${components.join("/")}`;
  const bashCredential = (
    (!template && (basename === ".env" || basename.startsWith(".env.")))
    || BASH_CREDENTIAL_BASENAME.test(basename)
    || /\/(?:\.ssh|\.aws|\.azure)(?:\/|$)/.test(componentPath)
    || /\/\.config\/gcloud(?:\/|$)/.test(componentPath)
  );
  return {
    bashCredential,
    fileToolSensitive: isSensitiveFile(input.inputBasename),
  };
}

export function isSensitiveFile(basename: string): boolean {
  if ([".env.example", ".env.template", ".env.sample"].includes(basename)) return false;
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(basename));
}

export function createSensitiveFilePermission(): ToolPermission {
  return (input: unknown, _ctx: ToolExecutionContext): PermissionDecision => {
    const inputRecord = input as { path: string };
    const basename = path.basename(inputRecord.path);

    if (classifySensitivePath({ inputBasename: basename, effectiveCanonicalPath: inputRecord.path }).fileToolSensitive) {
      return {
        outcome: "ask",
        reason: `File "${basename}" is a sensitive file.`,
        prompt: `Are you sure you want to access "${inputRecord.path}"? This file may contain secrets or credentials.`,
      };
    }

    return { outcome: "allow" };
  };
}
