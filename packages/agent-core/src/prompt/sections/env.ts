import type { PromptEnv } from "../types";

export function buildEnvSection(env: PromptEnv): string {
  const lines = [
    `Platform: ${env.platform}`,
    `Timezone: ${env.timezone}`,
    `Locale: ${env.locale}`,
    `Working directory: ${env.cwd}`,
    `Date: ${env.date}`,
  ];

  return `## Environment\n\n${lines.join("\n")}`;
}