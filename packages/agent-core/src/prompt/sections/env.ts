import type { PromptEnv } from "../types";

export function buildEnvSection(env: PromptEnv): string {
  const lines = [
    `Platform: ${env.platform}`,
    `Timezone: ${env.timezone}`,
    `Locale: ${env.locale}`,
    `Project root: ${env.projectRoot}`,
    `Working directory: ${env.cwd}`,
    `Execution mode: ${env.cwd === env.projectRoot ? "project" : "worktree"}`,
    `Date: ${env.date}`,
    "Project state remains owned by the project root. Filesystem, shell, Git, Skill, and LSP tool paths resolve from and are scoped to the working directory.",
    "Worktree mode isolates the default working directory and Git branch; it is not an operating-system sandbox. Respect permission decisions for any explicit access outside it.",
    "Change Session worktrees only when the user explicitly asks. Do not enumerate other worktrees. Never invoke Git worktree commands or edit Git metadata directly through shell/file tools.",
  ];

  return `## Environment\n\n${lines.join("\n")}`;
}
