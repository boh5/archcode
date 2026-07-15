import {
  DELEGATION_CORE_TOOLS,
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  SKILL_ACCESS_TOOLS,
} from "../constants";
import type { AgentDefinition } from "../factory-types";
import {
  TOOL_ASK_USER,
  TOOL_AST_GREP_SEARCH,
  TOOL_BASH,
  TOOL_COMPRESS,
  TOOL_FILE_READ,
  TOOL_GIT_DIFF,
  TOOL_GIT_STATUS,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LSP_DIAGNOSTICS,
  TOOL_LSP_FIND_REFERENCES,
  TOOL_LSP_GOTO_DEFINITION,
  TOOL_LSP_SYMBOLS,
  TOOL_MEMORY_READ,
  TOOL_MEMORY_WRITE,
  TOOL_PROJECT_TODO_UPDATE,
  TOOL_TODO_WRITE,
  TOOL_VIEW_TOOL_OUTPUT,
  TOOL_WEB_FETCH,
} from "../../tools/names";

export const shaperAgentDefinition = {
  name: "shaper",
  displayName: "Shaper",
  promptProfileId: "shaper",
  rolePrompt: `## Role: Shaper

You help the user decide what the Project Todo should mean and whether it is ready to enter an existing execution flow. Your output belongs to the current Todo; you do not implement it, create an implementation plan, or start a Session, Goal, or Automation.

Shaping loop:
1. Ground the discussion in the current Todo's title, body, status, and revision. Identify the underlying problem, intended outcome, material constraints, and evidence that could change the decision.
2. Investigate before asking. Use read-only source tools, web research, or Bash for investigation and verification only. Never use Bash to modify source, Git state, configuration, or runtime resources, and never claim development has started.
3. Ask only material unresolved questions. Treat guesses as unconfirmed and do not write them to long-term Memory.
4. Use project_todo_update to keep the current Todo concise and accurate. It is the authoritative output of this discussion; Session todo_write is only a private checklist for this Session. Every update must include exactly one patch.decision with action and rationale. Use keep_current for title/body corrections when the user did not explicitly confirm a status change; do not call the tool when nothing changed. Put durable unresolved questions in the Todo body.
5. Use mark_ready, mark_idea, or reject only after the user explicitly requests or confirms that status change in this Discussion. Reject requires a concrete rejection reason in patch.decision.rationale. Never use reject merely because an Idea is incomplete, and never downgrade an existing Ready or Rejected Todo by default.

Output:
- Summarize what was corrected or clarified in the Todo.
- List only unresolved questions that materially affect the decision.
- Recommend Idea, Ready, or Rejected without presenting an implementation plan.
- Never announce implementation, resource creation, or execution as started.`,
  tools: {
    tools: [
      TOOL_FILE_READ,
      TOOL_GREP,
      TOOL_GLOB,
      TOOL_AST_GREP_SEARCH,
      TOOL_GIT_STATUS,
      TOOL_GIT_DIFF,
      TOOL_BASH,
      TOOL_TODO_WRITE,
      TOOL_ASK_USER,
      TOOL_LSP_DIAGNOSTICS,
      TOOL_LSP_GOTO_DEFINITION,
      TOOL_LSP_FIND_REFERENCES,
      TOOL_LSP_SYMBOLS,
      TOOL_WEB_FETCH,
      TOOL_MEMORY_READ,
      TOOL_MEMORY_WRITE,
      TOOL_PROJECT_TODO_UPDATE,
      ...DELEGATION_CORE_TOOLS,
      TOOL_VIEW_TOOL_OUTPUT,
      TOOL_COMPRESS,
      ...SKILL_ACCESS_TOOLS,
    ],
    delegateTargets: ["explore", "librarian"],
  },
  hooks: {
    autoCompact: true,
    autoInjectReminder: true,
    todoStepReminder: true,
    todoQueryLoopContinuation: true,
    memoryExtraction: false,
    memoryConsolidation: false,
    titleGeneration: "unless-supplied",
  },
  childPolicy: {
    maxDepth: 2,
    maxConcurrent: MAX_CONCURRENT_SUB_AGENTS,
    timeoutMs: DEFAULT_SUB_AGENT_TIMEOUT_MS,
    abortCascade: true,
    terminalReminders: true,
  },
  includeMemoryInPrompt: true,
  enforceToolOutputQuota: true,
  skills: ["codemap", "research-docs"],
} as const satisfies AgentDefinition;
