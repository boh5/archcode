import type { ServerConfigValidationIssue } from "@archcode/protocol";

import {
  SECRET_LITERAL_MAX_BYTES,
  SECRET_LITERAL_MAX_COUNT,
  SECRET_LITERAL_MAX_TOTAL_BYTES,
  SECRET_LITERAL_MIN_BYTES,
} from "../security";
import { ConfigSemanticValidationError } from "./server-config-service";
import type { ProvidersConfig } from "./provider";
import type { ResolvedMcpConfig } from "./mcp";
import type { ResolvedGithubIntegrationConfig } from "./schema";

export interface RuntimeSecretLiteralInput {
  readonly path: string;
  readonly value: string;
}

/**
 * Immutable startup registry for exact runtime secret literals. It owns the
 * configuration-policy diagnostics; output redaction only receives values.
 */
export class SecretLiteralRegistry {
  readonly #values: readonly string[];

  constructor(inputs: Iterable<RuntimeSecretLiteralInput>) {
    const entries = [...inputs];
    const issues: ServerConfigValidationIssue[] = [];
    const unique = new Map<string, string>();

    for (const entry of entries) {
      const bytes = Buffer.byteLength(entry.value, "utf8");
      if (bytes < SECRET_LITERAL_MIN_BYTES || bytes > SECRET_LITERAL_MAX_BYTES) {
        issues.push({
          path: entry.path,
          message: `Runtime secret literal must contain ${SECRET_LITERAL_MIN_BYTES} to ${SECRET_LITERAL_MAX_BYTES} UTF-8 bytes`,
        });
        continue;
      }
      if (!unique.has(entry.value)) unique.set(entry.value, entry.path);
    }

    if (unique.size > SECRET_LITERAL_MAX_COUNT) {
      issues.push({
        path: "runtime.secretLiterals",
        message: `Runtime secret literals exceed the ${SECRET_LITERAL_MAX_COUNT}-entry limit`,
      });
    }
    const totalBytes = [...unique.keys()]
      .reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
    if (totalBytes > SECRET_LITERAL_MAX_TOTAL_BYTES) {
      issues.push({
        path: "runtime.secretLiterals",
        message: `Runtime secret literals exceed the ${SECRET_LITERAL_MAX_TOTAL_BYTES}-byte aggregate limit`,
      });
    }
    if (issues.length > 0) {
      throw new ConfigSemanticValidationError(issues, "Invalid runtime secret literal configuration");
    }

    this.#values = Object.freeze([...unique.keys()]);
  }

  values(): readonly string[] {
    return this.#values;
  }
}

export function collectRuntimeSecretLiterals(input: {
  readonly providers: ProvidersConfig;
  readonly userMcp: ResolvedMcpConfig;
  readonly github: ResolvedGithubIntegrationConfig;
  readonly externalLiterals: readonly string[];
}): SecretLiteralRegistry {
  const literals: RuntimeSecretLiteralInput[] = [];

  for (const [providerId, provider] of Object.entries(input.providers)) {
    const prefix = `provider.${providerId}.options`;
    if (provider.options.apiKey !== undefined) {
      literals.push({ path: `${prefix}.apiKey`, value: provider.options.apiKey });
    }
    collectRecordValues(literals, `${prefix}.headers`, provider.options.headers);
    collectRecordValues(literals, `${prefix}.queryParams`, provider.options.queryParams);
  }

  for (const [serverName, server] of Object.entries(input.userMcp.servers)) {
    const prefix = `mcp.servers.${serverName}`;
    literals.push({ path: `${prefix}.url`, value: server.url });
    collectRecordValues(literals, `${prefix}.headers`, server.headers);
  }

  if (input.github.token !== undefined) {
    literals.push({ path: "integrations.github.token", value: input.github.token });
  }
  input.externalLiterals.forEach((value, index) => {
    literals.push({ path: `runtime.externalSecretLiterals.${index}`, value });
  });

  return new SecretLiteralRegistry(literals);
}

function collectRecordValues(
  target: RuntimeSecretLiteralInput[],
  prefix: string,
  values: Readonly<Record<string, string>> | undefined,
): void {
  for (const [key, value] of Object.entries(values ?? {})) {
    target.push({ path: `${prefix}.${key}`, value });
  }
}
