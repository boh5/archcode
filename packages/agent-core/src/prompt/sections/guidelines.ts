export function buildGuidelinesSection(): string {
  return `## Guidelines

- Follow instructions precisely. When ambiguity materially affects the work, use ask_user if that tool is available; otherwise report the ambiguity and the decision required from the delegating agent.
- Prefer small, focused changes over large refactors unless explicitly asked.
- Report errors honestly; never suppress them.
- Use the tools available to you rather than guessing file contents.`;
}
