import type { SessionGoalView } from "../../api/types";
import { useSessionStore } from "../../store/session-store";
import { TodoProgressButton } from "./TodoProgressButton";
import { InspectorToggleButton } from "./InspectorToggleButton";

interface ChatHeaderProps {
  slug: string;
  sessionId: string;
  goal?: SessionGoalView;
  projectRoot?: string;
  onToggleInspector: () => void;
  inspectorExpanded: boolean;
}

export function ChatHeader({ slug, sessionId, goal, projectRoot, onToggleInspector, inspectorExpanded }: ChatHeaderProps) {
  const title = useSessionStore(sessionId, (s) => s.title, slug);
  const stats = useSessionStore(sessionId, (s) => s.stats, slug);
  const cwd = useSessionStore(sessionId, (s) => s.cwd, slug);

  const hasStats = stats && (stats.messages.total > 0 || stats.tools.calls > 0 || stats.usage.totalTokens > 0);

  return (
    <div className="flex items-center justify-between px-4 h-12 border-b border-border-subtle shrink-0 bg-bg-surface">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="font-semibold text-sm text-text-primary truncate">{title ?? "Untitled"}</span>
        {goal && (
          <span
            data-testid="goal-status-badge"
            className="text-[11px] px-2 py-0.5 rounded-sm font-medium whitespace-nowrap"
          >
            <span className="rounded-sm bg-accent-muted px-1.5 py-0.5 text-accent">
              {goal.status}
            </span>
          </span>
        )}
        {cwd !== null && projectRoot !== undefined && cwd !== projectRoot && (
          <span
            data-testid="session-worktree-badge"
            title={cwd}
            className="rounded-sm bg-info-muted px-1.5 py-0.5 font-mono text-[10.5px] text-info whitespace-nowrap"
          >
            worktree
          </span>
        )}
        {hasStats && (
          <span className="text-xs text-text-tertiary whitespace-nowrap">
            · Messages: {stats.messages.total} · Tools: {stats.tools.calls} · Tokens: {stats.usage.totalTokens.toLocaleString()}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <TodoProgressButton slug={slug} sessionId={sessionId} />
        <InspectorToggleButton
          expanded={inspectorExpanded}
          onToggle={onToggleInspector}
          iconSize={16}
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-sm border border-border-default bg-transparent text-text-tertiary transition-colors hover:border-border-strong hover:bg-bg-hover hover:text-text-primary max-[799px]:hidden"
        />
      </div>
    </div>
  );
}
