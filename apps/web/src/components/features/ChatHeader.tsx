import type { SessionExecutionRecord } from "@archcode/protocol";
import { useSessionStore } from "../../store/session-store";
import { TodoProgressButton } from "./TodoProgressButton";
import { InspectorToggleButton } from "./InspectorToggleButton";
import { executionVisualKind, presentExecutionStatus } from "../../lib/execution-status-presentation";
import { STATUS_SUBTLE_CLASS, STATUS_TONE_CLASS, statusVisual } from "../../lib/status-visuals";
import { StatusGlyph } from "../primitives/StatusGlyph";
import { GoalStatusMark } from "./GoalStatusMark";
import { presentSessionGoalStatus } from "../../lib/session-goal-presentation";

interface ChatHeaderProps {
  slug: string;
  sessionId: string;
  projectRoot?: string;
  onToggleInspector: () => void;
  inspectorExpanded: boolean;
}

function formatModelBinding(execution: SessionExecutionRecord): string {
  const model = execution.binding.modelDisplayName || execution.binding.modelId;
  return execution.binding.selection.variant ? `${model} · ${execution.binding.selection.variant}` : model;
}

export function ChatHeader({ slug, sessionId, projectRoot, onToggleInspector, inspectorExpanded }: ChatHeaderProps) {
  const title = useSessionStore(sessionId, (state) => state.title, slug);
  const goal = useSessionStore(sessionId, (state) => state.goal, slug);
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
  const executionKind = execution ? executionVisualKind(execution.status, executionCheckpoint) : undefined;
  const hasStats = stats.messages.total > 0 || stats.tools.calls > 0 || stats.usage.totalTokens > 0;
  const isWorktree = cwd !== null && projectRoot !== undefined && cwd !== projectRoot;

  return (
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border-default bg-bg-surface px-4 py-2 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="min-w-0 truncate text-[18px] font-semibold leading-6 tracking-[-0.02em] text-text-primary">{title ?? "Untitled"}</h1>
          {executionStatus && (
            <span
              data-testid="session-execution-status"
              data-execution-status={execution?.status}
              data-product-status={executionStatus.productStatus}
              title={executionStatus.detail ? `${executionStatus.label} · ${executionStatus.detail}` : executionStatus.label}
              className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 border-l-2 px-2 text-[11px] font-semibold ${execution?.status === "running" ? "border-l-signal bg-signal-field text-signal-foreground" : `border-l-border-strong ${executionKind ? STATUS_SUBTLE_CLASS[statusVisual(executionKind).tone] : ""} ${executionKind ? STATUS_TONE_CLASS[statusVisual(executionKind).tone] : ""}`}`}
            >
              {executionKind && <StatusGlyph kind={executionKind} size={13} />}
              {executionStatus.label}
              {executionStatus.detail && <span className="font-normal opacity-70">· {executionStatus.detail}</span>}
            </span>
          )}
        </div>

        <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-text-tertiary">
          {cwd !== null && (
            <span className="min-w-0 max-w-[420px] truncate font-mono max-[639px]:hidden" title={cwd} data-testid="session-cwd">
              {cwd}
            </span>
          )}
          {isWorktree && (
            <span
              data-testid="session-worktree-badge"
              title={cwd ?? undefined}
              className="shrink-0 rounded-sm bg-info-muted px-2 py-1 font-mono text-[11px] text-info"
            >
              worktree
            </span>
          )}
          {goal && (
            <>
              <span aria-hidden="true" className="text-border-strong">·</span>
              <span data-testid="goal-status-badge" className="inline-flex shrink-0 items-center gap-1 text-text-secondary">
                <GoalStatusMark identity={goal.instanceId} status={goal.status} size={12} label={`Goal ${presentSessionGoalStatus(goal.status).label}`} />
                <span>{presentSessionGoalStatus(goal.status).label}</span>
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

      <div className="flex shrink-0 items-center gap-2">
        <TodoProgressButton slug={slug} sessionId={sessionId} />
        <InspectorToggleButton
          expanded={inspectorExpanded}
          onToggle={onToggleInspector}
          iconSize={16}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-border-default bg-transparent text-text-tertiary transition-colors hover:border-border-strong hover:bg-bg-hover hover:text-text-primary"
        />
      </div>
    </header>
  );
}
