import { useState } from "react";
import { ChevronRight, FileText, Search, Wrench, Globe, GitBranch, Brain } from "lucide-react";
import type { ToolPart } from "@archcode/protocol";
import { ToolCard } from "./ToolCard";

const VERB_BY_TOOL: Record<string, string> = {
  file_read: "Read",
  artifact_read: "Read",
  memory_read: "Read",
  grep: "Searched",
  glob: "Searched",
  ast_grep_search: "Searched",
  lsp_diagnostics: "Checked",
  lsp_goto_definition: "Resolved",
  lsp_find_references: "Resolved",
  lsp_symbols: "Listed",
  web_fetch: "Fetched",
  git_status: "Checked",
  git_diff: "Diffed",
};

const ICON_BY_TOOL: Record<string, typeof FileText> = {
  file_read: FileText,
  artifact_read: FileText,
  memory_read: Brain,
  grep: Search,
  glob: Search,
  ast_grep_search: Search,
  lsp_diagnostics: Wrench,
  lsp_goto_definition: Wrench,
  lsp_find_references: Wrench,
  lsp_symbols: Wrench,
  web_fetch: Globe,
  git_status: GitBranch,
  git_diff: GitBranch,
};

export function GroupedToolCard({ tools }: { tools: ToolPart[] }) {
  const [expanded, setExpanded] = useState(false);

  const count = tools.length;
  const isAllSame = tools.every((t) => t.toolName === tools[0].toolName);

  const Icon = ICON_BY_TOOL[tools[0].toolName] ?? FileText;

  let label: string;
  if (isAllSame) {
    const verb = VERB_BY_TOOL[tools[0].toolName] ?? "Ran";
    label = `${verb} ${count} ${count === 1 ? "item" : "items"}`;
  } else {
    label = `Ran ${count} read-only tools`;
  }

  return (
    <div className="mb-1.5 shrink-0">
      <button
        type="button"
        className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs text-text-secondary rounded-md border border-border-subtle bg-bg-overlay hover:bg-bg-hover transition-colors"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <ChevronRight
          size={12}
          className={`transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        <Icon size={12} className="text-text-muted" aria-hidden="true" />
        <span className="font-medium">{label}</span>
        <span className="ml-auto text-[11px] text-text-muted bg-bg-active px-1.5 py-0.5 rounded-full">
          {count}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 ml-2 border-l border-border-subtle pl-2 flex flex-col gap-1.5">
          {tools.map((tool) => (
            <ToolCard key={tool.id} part={tool} />
          ))}
        </div>
      )}
    </div>
  );
}
