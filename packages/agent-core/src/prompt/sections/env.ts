import type { PromptEnv } from "../types";

export function buildEnvSection(env: PromptEnv): string {
  const executionMode = env.cwd === env.projectRoot ? "project" : "worktree";
  const lines = [
    `Platform: ${env.platform}`,
    `Timezone: ${env.timezone}`,
    `Locale: ${env.locale}`,
    `Project root: ${env.projectRoot}`,
    `Working directory: ${env.cwd}`,
    `Execution mode: ${executionMode}`,
    `Version control: ${env.versionControl}`,
    `Date: ${env.date}`,
    "Project state remains owned by the project root. Filesystem, shell, Skill, and LSP tool paths resolve from and are scoped to the working directory.",
    "The working directory is not an operating-system sandbox. Respect permission decisions for any explicit access outside it.",
    "Git-specific instructions elsewhere in this prompt apply only when Version control is git. When it is none, use file inspection and other non-Git evidence instead.",
  ];

  if (env.versionControl === "git") {
    lines.push(
      "A Git repository is detected for the working directory. Git tool and command paths resolve from the working directory.",
      "Worktree mode isolates the default working directory and Git branch.",
      "Change Session worktrees only when the user explicitly asks. Do not enumerate other worktrees. Never invoke Git worktree commands or edit Git metadata directly through shell/file tools.",
    );
  } else {
    lines.push(
      "No Git repository is detected for the working directory. Do not call git_status, git_diff, Session worktree tools, or Git commands unless the user explicitly asks to initialize or re-check version control.",
    );
  }

  return `## Environment\n\n${lines.join("\n")}`;
}
