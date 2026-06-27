import { CircleX, Menu } from "lucide-react";
import { usePostCommand } from "../../api/mutations";
import { useWorkflow } from "../../api/queries";
import type { WorkflowState } from "../../api/types";
import { useSessionStore } from "../../store/session-store";

const STAGE_LABELS: Record<string, string> = {
  idle: "Idle",
  product_drafting: "Product",
  critic_prd_review: "Critic PRD",
  spec_drafting: "Spec",
  critic_spec_review: "Critic Spec",
  awaiting_user_approval: "Approval",
  foreman_executing: "Foreman",
  final_review: "Review",
  researching: "Research",
  research_consolidation: "Consolidating",
  quick_analysis: "Analysis",
  quick_patch: "Patching",
  quick_verify: "Verifying",
};

interface ChatHeaderProps {
  slug: string;
  sessionId: string;
  workflowId?: string;
  onToggleDetail: () => void;
}

export function ChatHeader({ slug, sessionId, workflowId = "", onToggleDetail }: ChatHeaderProps) {
  const title = useSessionStore(sessionId, (s) => s.title, slug);
  const stats = useSessionStore(sessionId, (s) => s.stats, slug);
  const { data: workflow } = useWorkflow(slug, workflowId);
  const postCommand = usePostCommand();

  const handleCompact = () => {
    postCommand.mutate({ slug, sessionId, name: "compact" });
  };

  const wf = workflow as WorkflowState | null | undefined;
  const stageLabel = wf?.stage ? (STAGE_LABELS[wf.stage] ?? wf.stage) : null;
  const hasStats = stats && (stats.messages.total > 0 || stats.tools.calls > 0 || stats.usage.totalTokens > 0);

  return (
    <div className="flex items-center justify-between px-4 h-12 border-b border-border-subtle shrink-0 bg-bg-surface">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="font-semibold text-sm text-text-primary truncate">{title ?? "Untitled"}</span>
        {stageLabel && (
          <span className="text-xs text-text-muted whitespace-nowrap">· {stageLabel}</span>
        )}
        {hasStats && (
          <span className="text-xs text-text-tertiary whitespace-nowrap">
            · Messages: {stats.messages.total} · Tools: {stats.tools.calls} · Tokens: {stats.usage.totalTokens.toLocaleString()}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <button
          className="w-[30px] h-[30px] rounded-sm border border-border-default bg-transparent text-text-tertiary cursor-pointer flex items-center justify-center transition-all duration-150 hover:bg-bg-hover hover:text-text-primary hover:border-border-strong"
          title="Compact context"
          onClick={handleCompact}
          disabled={postCommand.isPending}
        >
          <CircleX size={16} />
        </button>
        <button
          className="w-[30px] h-[30px] rounded-sm border border-border-default bg-transparent text-text-tertiary cursor-pointer flex items-center justify-center transition-all duration-150 hover:bg-bg-hover hover:text-text-primary hover:border-border-strong"
          title="Toggle detail panel"
          onClick={onToggleDetail}
        >
          <Menu size={16} />
        </button>
      </div>
    </div>
  );
}