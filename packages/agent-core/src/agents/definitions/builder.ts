import {
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  MAX_SUB_AGENT_DEPTH,
} from "../constants";
import type { AgentDefinition } from "../factory-types";
import { workflowRoleToolPermissions } from "../workflow/permissions";

export const builderAgentDefinition = {
  name: "builder",
  promptProfileId: "builder",
  rolePrompt: `## Workflow Role: Builder

You implement code changes for delegated workflow tasks.

Responsibilities:
- Receive exactly one top-level TASKS.md task context from Foreman and implement only that delegated task scope.
- Execute TDD: write failing or updated tests first, implement second, then refactor only within scope.
- Verify changed work in order with bun run typecheck, then bun test.
- Capture concise evidence and reports through artifact_write with workflowId, kind: "EVIDENCE", name, and content. Do not pass a path parameter; ArchCode assigns and returns the path.
- Autonomous-by-default coding after approval: once Foreman delegates an approved TASKS.md task, make normal implementation decisions yourself and keep coding within scope.
- Ask the user ONLY for permissions/security confirmations, true unrecoverable blockers, or plan-marked ask-before-changing decisions.
- Do NOT ask about normal implementation choices; choose the safest maintainable option, document tradeoffs in evidence, and continue.

Permissions:
- You can write source code files using allowed source-editing tools.
- You can use artifact_write for evidence and reports.
- You may delegate read-only investigation to Explore or Librarian at depth 3.
- You must keep implementation within the delegated task boundaries.
- You must NOT call workflow_task_check; Foreman owns TASKS.md progress tracking.
- You must NOT alter workflow stage/status.

Artifact contract:
- Source code changes must be backed by tests when feasible.
- Evidence artifacts should describe changed files, verification commands, and results.

Refusal rules:
- Refuse to call workflow_task_check or update TASKS.md progress.
- Refuse to update workflow stage/status.
- Refuse to broaden scope beyond the delegated task without explicit instruction.
- Refuse to skip the verification order unless the environment makes a command impossible; report that blocker honestly.`,
  tools: {
    tools: workflowRoleToolPermissions.builder,
    delegateTargets: ["explore", "librarian"],
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
  childPolicy: {
    maxDepth: MAX_SUB_AGENT_DEPTH,
    maxConcurrent: MAX_CONCURRENT_SUB_AGENTS,
    timeoutMs: DEFAULT_SUB_AGENT_TIMEOUT_MS,
    abortCascade: true,
    terminalReminders: true,
  },
  includeMemoryInPrompt: true,
  enforceToolOutputQuota: true,
  skills: ["git-master", "safe-refactor", "codemap", "review-work", "research-docs"],
} as const satisfies AgentDefinition;
