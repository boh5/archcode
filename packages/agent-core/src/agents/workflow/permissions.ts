import { EXPLORER_READ_ONLY_TOOLS } from "../constants";

const WORKFLOW_PRD_SPEC_WRITE_TOOLS = ["workflow_read", "artifact_write"] as const;
const WORKFLOW_CREATE_PRD_SPEC_WRITE_TOOLS = ["workflow_create", ...WORKFLOW_PRD_SPEC_WRITE_TOOLS] as const;
const WORKFLOW_TASK_CHECK_TOOLS = ["artifact_read", "workflow_read", "workflow_task_check"] as const;
const ARTIFACT_EVIDENCE_WRITE_TOOLS = ["artifact_write"] as const;

const TODO_AND_ASK_TOOLS = ["ask_user", "todo_write"] as const;
const DELEGATION_EXECUTION_TOOLS = [
  "delegate",
  "background_output",
  "wait_for_reminder",
  "view_tool_output",
] as const;
const MEMORY_READ_TOOLS = ["memory_read"] as const;
const MEMORY_WRITE_TOOLS = ["memory_read", "memory_write"] as const;
const SOURCE_WRITE_TOOLS = ["file_write", "file_edit", "bash", "ast_grep_replace"] as const;

function uniqueTools<const T extends readonly string[]>(tools: T): readonly T[number][] {
  return [...new Set(tools)] as readonly T[number][];
}

export const workflowRoleToolPermissions = {
  product: uniqueTools([
    ...WORKFLOW_CREATE_PRD_SPEC_WRITE_TOOLS,
    ...EXPLORER_READ_ONLY_TOOLS,
    ...TODO_AND_ASK_TOOLS,
  ]),
  spec: uniqueTools([
    ...WORKFLOW_PRD_SPEC_WRITE_TOOLS,
    ...EXPLORER_READ_ONLY_TOOLS,
    ...TODO_AND_ASK_TOOLS,
  ]),
  critic: uniqueTools([
    ...WORKFLOW_PRD_SPEC_WRITE_TOOLS,
    ...EXPLORER_READ_ONLY_TOOLS,
    ...TODO_AND_ASK_TOOLS,
  ]),
  foreman: uniqueTools([
    ...WORKFLOW_TASK_CHECK_TOOLS,
    ...EXPLORER_READ_ONLY_TOOLS,
    ...DELEGATION_EXECUTION_TOOLS,
    ...TODO_AND_ASK_TOOLS,
  ]),
  builder: uniqueTools([
    ...EXPLORER_READ_ONLY_TOOLS,
    ...SOURCE_WRITE_TOOLS,
    ...DELEGATION_EXECUTION_TOOLS,
    ...TODO_AND_ASK_TOOLS,
    ...MEMORY_WRITE_TOOLS,
    ...ARTIFACT_EVIDENCE_WRITE_TOOLS,
  ]),
  reviewer: uniqueTools([
    ...EXPLORER_READ_ONLY_TOOLS,
    ...ARTIFACT_EVIDENCE_WRITE_TOOLS,
    ...TODO_AND_ASK_TOOLS,
    ...MEMORY_READ_TOOLS,
  ]),
  librarian: uniqueTools([
    ...EXPLORER_READ_ONLY_TOOLS,
    ...MEMORY_READ_TOOLS,
    "ask_user",
  ]),
} as const;

export type WorkflowRoleName = keyof typeof workflowRoleToolPermissions;
