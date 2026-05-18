import { usePostCommand } from "../../api/mutations";
import { useWorkflow } from "../../api/queries";
import type { WorkflowState } from "../../api/types";
import { useSessionStore } from "../../store/session-store";

interface ChatHeaderProps {
  slug: string;
  sessionId: string;
  onToggleDetail: () => void;
}

export function ChatHeader({ slug, sessionId, onToggleDetail }: ChatHeaderProps) {
  const title = useSessionStore(sessionId, (s) => s.title);
  const { data: workflow } = useWorkflow(slug, sessionId);
  const postCommand = usePostCommand();

  const handleCompact = () => {
    postCommand.mutate({ slug, sessionId, name: "compact" });
  };

  const wf = workflow as WorkflowState | null | undefined;
  const pipelineStage = wf ? (wf.currentStep ?? wf.stage ?? null) : null;

  return (
    <div className="chat-header">
      <div className="chat-header-left">
        <span className="chat-title">{title ?? "Untitled"}</span>
        {pipelineStage && (
          <span className="chat-subtitle">· Pipeline: {pipelineStage}</span>
        )}
      </div>
      <div className="chat-header-right">
        <button
          className="chat-header-btn"
          title="Compact context"
          onClick={handleCompact}
          disabled={postCommand.isPending}
        >
          ⦻
        </button>
        <button
          className="chat-header-btn"
          title="Toggle detail panel"
          onClick={onToggleDetail}
        >
          ☰
        </button>
      </div>
    </div>
  );
}