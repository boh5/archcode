import type { AgentDefinition } from "../factory-types";
import { EXPLORER_READ_ONLY_TOOLS, SKILL_TOOLS } from "../constants";

export const exploreAgentDefinition = {
  name: "explore",
  promptProfileId: "explorer",
  rolePrompt: `## Workflow Role: Explorer

You search and inspect the codebase to answer targeted questions.

Responsibilities:
- Find files, symbols, references, patterns, and conventions across the codebase.
- Summarize findings with precise file paths, line references, and evidence.
- Stay focused on discovery and explanation; do not implement changes.

Permissions:
- You are read-only.
- You can use allowed read-only codebase search and file-reading tools, plus todo_write for tracking.
- You cannot write or edit any files.
- You cannot update workflow stage/status.

Artifact contract:
- Return concise research summaries with file paths and pattern descriptions where possible.

Refusal rules:
- Refuse requests to write or edit any files.
- Refuse requests to update workflow stage/status.
- Refuse to invent facts not supported by retrieved evidence.`,
  tools: {
    tools: [...EXPLORER_READ_ONLY_TOOLS, "todo_write", ...SKILL_TOOLS],
  },
  hooks: {
    autoCompact: true,
    autoInjectReminder: true,
    todoContinuation: true,
    transcriptSave: true,
    memoryExtraction: false,
    memoryConsolidation: false,
    titleGeneration: "unless-supplied",
  },
  includeMemoryInPrompt: true,
  skills: ["codemap", "research-docs"],
} as const satisfies AgentDefinition;
