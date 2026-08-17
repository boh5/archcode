import { Link } from "react-router-dom";
import { useSessionStore } from "../../store/session-store";
import { TodoProgressButton } from "./TodoProgressButton";
import { InspectorToggleButton } from "./InspectorToggleButton";
import {
  executionVisualKind,
  presentExecutionStatus,
} from "../../lib/execution-status-presentation";
import {
  STATUS_SUBTLE_CLASS,
  STATUS_TONE_CLASS,
  statusVisual,
} from "../../lib/status-visuals";
import { StatusGlyph } from "../primitives/StatusGlyph";

export interface ChatHeaderSource {
  label: string;
  title: string;
  to: string;
  usesLiveTodoReferences?: true;
}

interface ChatHeaderProps {
  slug: string;
  sessionId: string;
  source?: ChatHeaderSource;
  onToggleInspector: () => void;
  inspectorExpanded: boolean;
}

export function ChatHeader({
  slug,
  sessionId,
  source,
  onToggleInspector,
  inspectorExpanded,
}: ChatHeaderProps) {
  const title = useSessionStore(sessionId, (state) => state.title, slug);
  const stats = useSessionStore(sessionId, (state) => state.stats, slug);
  const cwd = useSessionStore(sessionId, (state) => state.cwd, slug);
  const executions = useSessionStore(
    sessionId,
    (state) => state.executions,
    slug,
  );
  const currentExecutionId = useSessionStore(
    sessionId,
    (state) => state.currentExecutionId,
    slug,
  );

  const currentExecutionIndex =
    currentExecutionId === undefined
      ? -1
      : executions.findIndex(
          (execution) => execution.id === currentExecutionId,
        );
  const executionIndex =
    currentExecutionIndex >= 0 ? currentExecutionIndex : executions.length - 1;
  const execution =
    executionIndex >= 0 ? executions[executionIndex] : undefined;
  const executionStatus = execution
    ? presentExecutionStatus(execution)
    : undefined;
  const executionKind = execution ? executionVisualKind(execution) : undefined;

  return (
    <header className="flex min-h-16 shrink-0 items-center gap-2.5 border-b border-border-default bg-bg-surface px-3 py-2.5 min-[761px]:gap-4 min-[761px]:px-[26px] min-[761px]:py-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="min-w-0 truncate text-[17px] font-semibold leading-[1.2] tracking-[-0.03em] text-text-primary min-[761px]:text-[20px]">
            {title ?? "Untitled"}
          </h1>
          {executionStatus && (
            <span
              data-testid="session-execution-status"
              data-execution-status={execution?.status}
              data-product-status={executionStatus.productStatus}
              title={
                executionStatus.detail
                  ? `${executionStatus.label} · ${executionStatus.detail}`
                  : executionStatus.label
              }
              className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[6px] border border-l-2 pl-2 pr-[9px] text-[11px] font-semibold tracking-[-0.01em] ${execution?.status === "running" ? "border-signal/30 border-l-signal bg-signal-field text-signal-foreground" : `border-border-default border-l-border-strong ${executionKind ? STATUS_SUBTLE_CLASS[statusVisual(executionKind).tone] : ""} ${executionKind ? STATUS_TONE_CLASS[statusVisual(executionKind).tone] : ""}`}`}
            >
              {executionKind && <StatusGlyph kind={executionKind} size={13} />}
              {executionStatus.label}
              {executionStatus.detail && (
                <span className="font-normal opacity-70">
                  · {executionStatus.detail}
                </span>
              )}
            </span>
          )}
        </div>

        <div className="mt-[5px] flex min-w-0 items-center gap-2 overflow-hidden text-[12px] leading-[1.3] text-text-tertiary">
          {cwd !== null && (
            <span
              className="min-w-0 max-w-[min(42vw,420px)] truncate font-mono text-[11.5px] [flex:0_10_auto] [@media(max-width:760px)]:hidden"
              title={cwd}
              data-testid="session-cwd"
            >
              {cwd}
            </span>
          )}
          {cwd !== null && (
            <span
              aria-hidden="true"
              className="shrink-0 text-border-strong [@media(max-width:760px)]:hidden"
            >
              ·
            </span>
          )}
          <span className="shrink-0 font-medium tabular-nums text-text-secondary" data-testid="session-stats">
            {stats.tools.calls.toLocaleString()} tools ·{" "}
            {stats.usage.totalTokens.toLocaleString()} tokens
          </span>
          {source && (
            <>
              <span
                aria-hidden="true"
                className="shrink-0 text-border-strong [@media(max-width:760px)]:hidden"
              >
                ·
              </span>
              <span
                className="min-w-0 truncate [flex:1_1_195px] [@media(max-width:760px)]:hidden"
                data-testid="session-source"
              >
                <span className="text-text-tertiary">{source.label}</span>{" "}
                <Link
                  className="font-medium text-text-secondary transition-colors hover:text-text-primary hover:underline"
                  data-testid="project-todo-backlink"
                  title={source.title}
                  to={source.to}
                >
                  {source.title}
                </Link>
                {source.usesLiveTodoReferences ? (
                  <span className="ml-1 text-text-tertiary" data-testid="session-source-annotation">
                    · Using live Todo references
                  </span>
                ) : null}
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
        />
      </div>
    </header>
  );
}
