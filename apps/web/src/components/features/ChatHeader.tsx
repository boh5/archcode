import type { SessionExecutionRecord } from "@archcode/protocol";
import type { SessionGoalView } from "../../api/types";
import { useSessionStore } from "../../store/session-store";
import { TodoProgressButton } from "./TodoProgressButton";
import { InspectorToggleButton } from "./InspectorToggleButton";
import { presentExecutionStatus, type ProductExecutionStatus } from "../../lib/execution-status-presentation";

interface ChatHeaderProps {
  slug: string;
  sessionId: string;
  goal?: SessionGoalView;
  projectRoot?: string;
  onToggleInspector: () => void;
  inspectorExpanded: boolean;
}

const EXECUTION_STATUS_CLASS: Record<ProductExecutionStatus, string> = {
  running: "bg-success-muted text-success",
  needs_you: "bg-warning-muted text-warning",
  completed: "bg-accent-muted text-accent",
  stopped: "bg-bg-active text-text-secondary",
};

function formatModelBinding(execution: SessionExecutionRecord): string {
  const model = execution.binding.modelDisplayName || execution.binding.modelId;
  return execution.binding.selection.variant ? `${model} · ${execution.binding.selection.variant}` : model;
}

export function ChatHeader({ slug, sessionId, goal, projectRoot, onToggleInspector, inspectorExpanded }: ChatHeaderProps) {
  const title = useSessionStore(sessionId, (state) => state.title, slug);
  const stats = useSessionStore(sessionId, (state) => state.stats, slug);
  const cwd = useSessionStore(sessionId, (state) => state.cwd, slug);
  const executions = useSessionStore(sessionId, (state) => state.executions, slug);
  const executionInputCheckpoints = useSessionStore(sessionId, (state) => state.executionInputCheckpoints ?? [], slug);
  const currentExecutionId = useSessionStore(sessionId, (state) => state.currentExecutionId, slug);

  const currentExecutionIndex = currentExecutionId === undefined
    ? -1
    : executions.findIndex((execution) => execution.id === currentExecutionId);
  const executionIndex = currentExecutionIndex >= 0 ? currentExecutionIndex : executions.length - 1;
  const execution = executionIndex >= 0 ? executions[executionIndex] : undefined;
  const executionCheckpoint = execution === undefined
    ? undefined
    : executionInputCheckpoints.find((checkpoint) => checkpoint.executionId === execution.id);
  const executionStatus = execution ? presentExecutionStatus(execution.status, executionCheckpoint) : undefined;
  const hasStats = stats.messages.total > 0 || stats.tools.calls > 0 || stats.usage.totalTokens > 0;
  const isWorktree = cwd !== null && projectRoot !== undefined && cwd !== projectRoot;

  return (
    <header className="flex min-h-[58px] shrink-0 items-center gap-3 border-b border-border-subtle bg-bg-surface px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="min-w-0 truncate text-sm font-semibold text-text-primary">{title ?? "Untitled"}</h1>
          {executionStatus && (
            <span
              data-testid="session-execution-status"
              data-execution-status={execution?.status}
              data-product-status={executionStatus.productStatus}
              title={executionStatus.detail ? `${executionStatus.label} · ${executionStatus.detail}` : executionStatus.label}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${EXECUTION_STATUS_CLASS[executionStatus.productStatus]}`}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full bg-current ${execution?.status === "running" ? "animate-pulse" : ""}`}
              />
              {executionStatus.label}
              {executionStatus.detail && <span className="font-normal opacity-70">· {executionStatus.detail}</span>}
            </span>
          )}
        </div>

        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10.5px] text-text-muted">
          {cwd !== null && (
            <span className="min-w-0 max-w-[420px] truncate font-mono max-[639px]:hidden" title={cwd} data-testid="session-cwd">
              {cwd}
            </span>
          )}
          {isWorktree && (
            <span
              data-testid="session-worktree-badge"
              title={cwd ?? undefined}
              className="shrink-0 rounded-sm bg-info-muted px-1.5 py-0.5 font-mono text-[10px] text-info"
            >
              worktree
            </span>
          )}
          {goal && (
            <>
              <span aria-hidden="true" className="text-border-strong">·</span>
              <span data-testid="goal-status-badge" className="shrink-0 text-text-secondary">
                Goal · {goal.status}
              </span>
            </>
          )}
          {execution && (
            <>
              <span aria-hidden="true" className="text-border-strong max-[719px]:hidden">·</span>
              <span data-testid="session-execution-meta" className="min-w-0 truncate max-[719px]:hidden">
                Execution {executionIndex + 1} · {formatModelBinding(execution)}
              </span>
            </>
          )}
          {hasStats && (
            <>
              <span aria-hidden="true" className="text-border-strong max-[1099px]:hidden">·</span>
              <span className="shrink-0 max-[1099px]:hidden" data-testid="session-stats">
                {stats.messages.total} messages · {stats.tools.calls} tools · {stats.usage.totalTokens.toLocaleString()} tokens
              </span>
            </>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <TodoProgressButton slug={slug} sessionId={sessionId} />
        <InspectorToggleButton
          expanded={inspectorExpanded}
          onToggle={onToggleInspector}
          iconSize={16}
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-sm border border-border-default bg-transparent text-text-tertiary transition-colors hover:border-border-strong hover:bg-bg-hover hover:text-text-primary"
        />
      </div>
    </header>
  );
}
