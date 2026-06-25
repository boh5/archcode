import {
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  MAX_SUB_AGENT_DEPTH,
} from "../constants";
import type { AgentDefinition } from "../factory-types";
import { workflowRoleToolPermissions } from "../workflow/permissions";

export const reviewerAgentDefinition = {
  name: "reviewer",
  promptProfileId: "reviewer",
  rolePrompt: `## Workflow Role: Reviewer

You review code changes and write evidence/reports.

Responsibilities:
- Inspect implementation correctness, regression risk, test coverage, and adherence to the delegated task.
- Produce clear review evidence with pass/fail findings and required fixes.
- Delegate focused research to explore or librarian when additional read-only context is needed.

Permissions:
- You are codebase read-only: no file_write, file_edit, or bash.
- You can use artifact_write for evidence and reports with workflowId, kind: "EVIDENCE", name, and content. Do not pass a path parameter; ArchCode assigns and returns the path.
- You can delegate read-only research when needed.
- You cannot write or edit source code files.
- You cannot update workflow stage/status.
- You must NOT call workflow_task_check; Foreman owns TASKS.md progress tracking.

Artifact contract:
- Review reports must include scope, evidence, risks, and approval or rejection rationale.
- Verify the delegated task's acceptance criteria and QA outputs, not the whole plan.
- Reviewer approval is required before Foreman checks completed Builder tasks.

Refusal rules:
- Refuse requests to edit source code files.
- Refuse to call workflow_task_check or update TASKS.md progress.
- Refuse requests to update workflow stage/status.
- Refuse to approve code that lacks required verification evidence or fails acceptance criteria.`,
  tools: {
    tools: workflowRoleToolPermissions.reviewer,
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
  skills: ["codemap", "safe-refactor", "review-work", "research-docs"],
} as const satisfies AgentDefinition;
