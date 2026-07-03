import type { SessionPart, ToolPart } from "@archcode/protocol";
import { TOOL_DELEGATE } from "@archcode/protocol";

export const READ_ONLY_TOOL_NAMES: Set<string> = new Set([
  "file_read",
  "grep",
  "glob",
  "ast_grep_search",
  "lsp_diagnostics",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_symbols",
  "web_fetch",
  "git_status",
  "git_diff",
  "memory_read",
]);

export interface GroupedToolsEntry {
  type: "grouped-tools";
  id: string;
  tools: ToolPart[];
}

function isCompletedReadOnlyTool(part: SessionPart): part is ToolPart {
  return (
    part.type === "tool" &&
    part.toolName !== TOOL_DELEGATE &&
    READ_ONLY_TOOL_NAMES.has(part.toolName) &&
    part.state === "completed"
  );
}

export function groupReadOnlyToolParts(
  parts: SessionPart[],
): Array<SessionPart | GroupedToolsEntry> {
  const result: Array<SessionPart | GroupedToolsEntry> = [];
  let run: ToolPart[] = [];

  const flushRun = () => {
    if (run.length >= 2) {
      const id = `${run[0].id}:${run[run.length - 1].id}`;
      result.push({ type: "grouped-tools", id, tools: run });
    } else {
      for (const t of run) result.push(t);
    }
    run = [];
  };

  for (const part of parts) {
    if (isCompletedReadOnlyTool(part)) {
      run.push(part);
    } else {
      flushRun();
      result.push(part);
    }
  }
  flushRun();

  return result;
}
