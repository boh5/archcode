import { useNavigate } from "react-router-dom";
import { MessageSquare } from "lucide-react";
import type { GoalState } from "../../api/types";

interface GoalChatProps {
  slug: string;
  goal: GoalState;
}

export function GoalChat({ slug, goal }: GoalChatProps) {
  const navigate = useNavigate();

  if (!goal.mainSessionId) {
    return (
      <div data-testid="goal-tab-chat" className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <MessageSquare size={24} className="text-text-muted" />
          <p className="text-sm text-text-tertiary">No main session for this goal yet</p>
        </div>
      </div>
    );
  }

  const handleOpenSession = () => {
    navigate(`/projects/${slug}/sessions/${goal.mainSessionId}`);
  };

  return (
    <div data-testid="goal-tab-chat" className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle shrink-0">
        <span className="text-[12.5px] text-text-secondary">
          Main session: <span className="font-mono text-text-muted">{goal.mainSessionId}</span>
        </span>
        <button
          className="text-[12px] px-3 py-1.5 rounded-sm bg-accent text-white hover:bg-accent-hover transition-colors duration-150 cursor-pointer"
          onClick={handleOpenSession}
        >
          Open full chat →
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-5 max-w-3xl mx-auto w-full">
        <div className="flex flex-col items-center justify-center gap-3 text-center py-12">
          <MessageSquare size={32} className="text-text-muted" />
          <p className="text-sm text-text-tertiary">
            Chat replay is available in the full session view
          </p>
          <button
            className="text-[12.5px] px-4 py-2 rounded-sm bg-bg-elevated border border-border-default text-text-primary hover:bg-bg-hover transition-colors duration-150 cursor-pointer"
            onClick={handleOpenSession}
          >
            Open session chat
          </button>
        </div>
      </div>
    </div>
  );
}