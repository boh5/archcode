import { useNavigate } from "react-router-dom";
import { MessageSquare, GitBranch } from "lucide-react";
import type { GoalState } from "../../api/types";

interface GoalSessionsProps {
  slug: string;
  goal: GoalState;
}

export function GoalSessions({ slug, goal }: GoalSessionsProps) {
  const navigate = useNavigate();

  const handleSessionClick = (sessionId: string) => {
    navigate(`/projects/${slug}/sessions/${sessionId}`);
  };

  return (
    <div data-testid="goal-tab-sessions" className="flex flex-col gap-3 p-5 max-w-3xl mx-auto w-full">
      {goal.mainSessionId && (
        <SessionEntry
          sessionId={goal.mainSessionId}
          label="Main Session"
          icon={<MessageSquare size={14} className="text-accent" />}
          onClick={() => handleSessionClick(goal.mainSessionId!)}
        />
      )}
      {goal.childSessionIds.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">
            Child Sessions
          </h3>
          {goal.childSessionIds.map((sessionId) => (
            <SessionEntry
              key={sessionId}
              sessionId={sessionId}
              label="Child Session"
              icon={<GitBranch size={14} className="text-text-tertiary" />}
              onClick={() => handleSessionClick(sessionId)}
            />
          ))}
        </div>
      )}
      {!goal.mainSessionId && goal.childSessionIds.length === 0 && (
        <p className="text-sm text-text-tertiary">No sessions associated with this goal yet</p>
      )}
    </div>
  );
}

function SessionEntry({
  sessionId,
  label,
  icon,
  onClick,
}: {
  sessionId: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2.5 px-3 py-2.5 rounded-md bg-bg-elevated border border-border-subtle cursor-pointer transition-colors duration-150 hover:bg-bg-hover"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
    >
      {icon}
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium text-text-primary">{label}</div>
        <div className="text-[11px] text-text-muted font-mono truncate">{sessionId}</div>
      </div>
      <span className="text-[11px] text-text-tertiary">Open →</span>
    </div>
  );
}