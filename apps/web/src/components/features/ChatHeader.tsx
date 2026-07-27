import { Link } from "react-router-dom";
import { useSessionStore } from "../../store/session-store";
import { TodoProgressButton } from "./TodoProgressButton";
import { InspectorToggleButton } from "./InspectorToggleButton";
import { executionVisualKind, presentExecutionStatus } from "../../lib/execution-status-presentation";
import { STATUS_SUBTLE_CLASS, STATUS_TONE_CLASS, statusVisual } from "../../lib/status-visuals";
import { StatusGlyph } from "../primitives/StatusGlyph";

export interface ChatHeaderSource {
  label: string;
  title: string;
  to: string;
}

interface ChatHeaderProps {
  slug: string;
  sessionId: string;
  source?: ChatHeaderSource;
  onToggleInspector: () => void;
  inspectorExpanded: boolean;
}

export function ChatHeader({ slug, sessionId, source, onToggleInspector, inspectorExpanded }: ChatHeaderProps) {
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
  const executionKind = execution ? executionVisualKind(execution.status, executionCheckpoint) : undefined;

  return (
    <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border-default bg-bg-surface px-4 py-2.5 sm:px-6">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="min-w-0 truncate text-[20px] font-semibold leading-7 tracking-[-0.025em] text-text-primary">{title ?? "Untitled"}</h1>
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

        <div className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden text-[12px] text-text-tertiary">
          {cwd !== null && (
            <span
              className="min-w-0 max-w-[420px] truncate font-mono [flex:0_10_auto] max-[760px]:hidden"
              title={cwd}
              data-testid="session-cwd"
            >
              {cwd}
            </span>
          )}
          {cwd !== null && (
            <span aria-hidden="true" className="shrink-0 text-border-strong max-[760px]:hidden">·</span>
          )}
          <span className="shrink-0 tabular-nums" data-testid="session-stats">
            {stats.tools.calls.toLocaleString()} tools · {stats.usage.totalTokens.toLocaleString()} tokens
          </span>
          {source && (
            <>
              <span aria-hidden="true" className="shrink-0 text-border-strong max-[760px]:hidden">·</span>
              <span className="min-w-0 truncate [flex:1_1_195px] max-[760px]:hidden" data-testid="session-source">
                <span className="text-text-tertiary">{source.label}</span>{" "}
                <Link
                  className="font-medium text-text-secondary transition-colors hover:text-text-primary hover:underline"
                  data-testid="project-todo-backlink"
                  title={source.title}
                  to={source.to}
                >
                  {source.title}
                </Link>
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
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-border-default bg-transparent text-text-tertiary transition-colors hover:border-border-strong hover:bg-bg-hover hover:text-text-primary [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
        />
      </div>
    </header>
  );
}
