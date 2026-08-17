import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Eye, LoaderCircle } from "lucide-react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { rootSessionSourceTodoId, type AgentDescriptor, type RootSessionSource } from "@archcode/protocol";
import {
  ExecutionWorkstream,
  retainExecutionWorkstreamUiState,
} from "../components/composite/ExecutionWorkstream";
import { SessionComposerDock } from "../components/features/SessionComposerDock";
import { DiffTab } from "../components/features/DiffTab";
import { TodoProgressButton } from "../components/features/TodoProgressButton";
import { InspectorToggleButton } from "../components/features/InspectorToggleButton";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { useAgents, useFocusedSession, useProjectTodos, useSession, useSessionInventory } from "../api/queries";
import {
  beginSessionSnapshotRecovery,
  getWebSessionStore,
  markSessionForeground,
  useSessionStore,
} from "../store/session-store";
import { useWorkbenchLayout } from "../context/workbench-layout";
import {
  createSessionSnapshotRecoveryRetry,
  type SessionSnapshotRecoveryRetry,
  type SessionSnapshotRequestState,
} from "../lib/session-snapshot-recovery-retry";
import { ApiError } from "../api/client";
import { executionVisualKind, presentExecutionStatus } from "../lib/execution-status-presentation";
import { STATUS_SUBTLE_CLASS, STATUS_TONE_CLASS, statusVisual } from "../lib/status-visuals";
import { SelectedTodoShell } from "./selected-todo-shell";
import { createTodoWorkNavigationState, readTodoWorkReturnState } from "./project-todo-detail";
import { useProjectLayoutOutletContext, type SessionInspectorTopInset } from "./project";
import type { Session } from "../api/types";
import { resolveAgentDisplayName } from "../lib/agent-constants";

export function hasSessionSnapshotRecoveryOwner(
  slug: string,
  sessionId: string | null,
): sessionId is string {
  return slug.length > 0 && sessionId !== null && sessionId.length > 0;
}

function useSessionSnapshotRecoveryRetry(input: {
  slug: string;
  sessionId: string | null;
  terminalFailure: boolean;
  fetching: boolean;
  refetch: () => Promise<unknown>;
}): void {
  const controllerRef = useRef<SessionSnapshotRecoveryRetry | null>(null);
  const requestStateRef = useRef<SessionSnapshotRequestState>({
    terminalFailure: input.terminalFailure,
    fetching: input.fetching,
  });
  requestStateRef.current = {
    terminalFailure: input.terminalFailure,
    fetching: input.fetching,
  };

  useEffect(() => {
    const ownerSessionId = input.sessionId;
    if (!hasSessionSnapshotRecoveryOwner(input.slug, ownerSessionId)) return;
    const store = getWebSessionStore(ownerSessionId, input.slug);
    const controller = createSessionSnapshotRecoveryRetry({
      readRecoveryState: () => {
        const state = store.getState();
        return {
          status: state.snapshotRecoveryStatus,
          generation: state.snapshotRecoveryGeneration,
        };
      },
      refetch: input.refetch,
    });
    controllerRef.current = controller;
    const unsubscribe = store.subscribe(() => {
      controller.update(requestStateRef.current);
    });
    controller.update(requestStateRef.current);

    return () => {
      unsubscribe();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [input.refetch, input.sessionId, input.slug]);

  useEffect(() => {
    controllerRef.current?.update(requestStateRef.current);
  }, [input.fetching, input.terminalFailure]);
}

export function effectiveSessionFocusId(
  routeSessionId: string,
  requestedFocusSessionId: string | null,
): string | null {
  return requestedFocusSessionId === null
    || requestedFocusSessionId.length === 0
    || requestedFocusSessionId === routeSessionId
    ? null
    : requestedFocusSessionId;
}

export type SessionShellMode =
  | {
      readonly kind: "todo-bound";
      readonly todoId: string;
      readonly sessionKind: "WORK SESSION" | "DISCUSSION" | "AUTOMATION SETUP" | "AUTOMATION SESSION";
      readonly sourceLabel: "Todo · Work" | "Todo · Discussion" | "Todo · Automation setup" | "Automation";
      readonly backLabel: "All work";
      readonly backTo: string;
    }
  | {
      readonly kind: "source-only";
      readonly sessionKind: "DIRECT SESSION" | "AUTOMATION SESSION";
      readonly sourceLabel: "Direct" | "Automation";
      readonly backLabel: "Runs" | "Schedules";
      readonly backTo: string;
    };

/** Derive the only Session shell branch from the canonical root source. */
export function deriveSessionShellMode(source: RootSessionSource, slug: string): SessionShellMode {
  const projectPath = `/projects/${encodeURIComponent(slug)}`;
  if (source.kind === "direct") {
    return {
      kind: "source-only",
      sessionKind: "DIRECT SESSION",
      sourceLabel: "Direct",
      backLabel: "Runs",
      backTo: `${projectPath}/sessions`,
    };
  }
  if (source.kind === "automation") {
    const automationPath = `${projectPath}/automations/${encodeURIComponent(source.automationId)}?invocation=${encodeURIComponent(source.invocationId)}`;
    if (source.todoId === null) {
      return {
        kind: "source-only",
        sessionKind: "AUTOMATION SESSION",
        sourceLabel: "Automation",
        backLabel: "Schedules",
        backTo: automationPath,
      };
    }
    return {
      kind: "todo-bound",
      todoId: source.todoId,
      sessionKind: "AUTOMATION SESSION",
      sourceLabel: "Automation",
      backLabel: "All work",
      backTo: `${projectPath}/todos/${encodeURIComponent(source.todoId)}/work`,
    };
  }
  const entry = source.entry;
  return {
    kind: "todo-bound",
    todoId: source.todoId,
    sessionKind: entry === "discussion"
      ? "DISCUSSION"
      : entry === "automation"
        ? "AUTOMATION SETUP"
        : "WORK SESSION",
    sourceLabel: entry === "discussion"
      ? "Todo · Discussion"
      : entry === "automation"
        ? "Todo · Automation setup"
        : "Todo · Work",
    backLabel: "All work",
    backTo: `${projectPath}/todos/${encodeURIComponent(source.todoId)}/work`,
  };
}

export function sessionInspectorTopInset(input: {
  mode: SessionShellMode | null;
  viewportWidth: number;
}): SessionInspectorTopInset {
  if (input.mode?.kind !== "todo-bound") return 58;
  if (input.viewportWidth <= 560) return 145;
  if (input.viewportWidth <= 720) return 115;
  return 108;
}

export function sessionSourceErrorReturn(source: RootSessionSource, slug: string): {
  readonly label: "Runs" | "Schedules";
  readonly to: string;
} {
  const projectPath = `/projects/${encodeURIComponent(slug)}`;
  if (source.kind === "direct") return { label: "Runs", to: `${projectPath}/sessions` };
  if (source.kind === "automation") {
    return {
      label: "Schedules",
      to: `${projectPath}/automations/${encodeURIComponent(source.automationId)}?invocation=${encodeURIComponent(source.invocationId)}`,
    };
  }
  return { label: "Runs", to: `${projectPath}/sessions` };
}

export function SessionRoute() {
  const location = useLocation();
  const { slug = "", sessionId = "" } = useParams<{
    slug: string;
    sessionId: string;
  }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const layout = useWorkbenchLayout();
  const projectLayout = useProjectLayoutOutletContext();
  const { openInspectorSurface, toggleInspectorSurface } = layout;
  const canvasView = searchParams.get("view");
  const selectedFile = searchParams.get("file") ?? undefined;

  const {
    data: session,
    isLoading: isSessionLoading,
    isFetching: isSessionFetching,
    error: sessionError,
    refetch: refetchSession,
  } = useSession(slug, sessionId);
  const projectTodos = useProjectTodos(slug);
  const sessionInventory = useSessionInventory(slug);
  const { data: agents = [] } = useAgents();
  const rootSessionId = session?.rootSessionId ?? sessionId;
  const sessionSource = session?.source;
  const shellMode = useMemo(
    () => sessionSource === undefined ? null : deriveSessionShellMode(sessionSource, slug),
    [sessionSource, slug],
  );
  const linkedProjectTodo = shellMode?.kind === "todo-bound"
    ? projectTodos.data?.find((todo) => todo.id === shellMode.todoId)
    : undefined;
  const linkedWorkCount = shellMode?.kind === "todo-bound"
    ? (sessionInventory.data ?? []).filter(({ session: inventorySession }) => (
        rootSessionSourceTodoId(inventorySession.source) === shellMode.todoId
      )).length
    : 0;
  const inspectorTopInset = sessionInspectorTopInset({
    mode: shellMode,
    viewportWidth: layout.viewportWidth,
  });
  const focusSessionId = effectiveSessionFocusId(
    sessionId,
    searchParams.get("focus"),
  );
  const {
    data: focusedSession,
    isLoading: isFocusedLoading,
    isFetching: isFocusedFetching,
    error: focusedError,
    refetch: refetchFocusedSession,
  } = useFocusedSession(slug, focusSessionId);
  useSessionSnapshotRecoveryRetry({
    slug,
    sessionId,
    terminalFailure: sessionError !== null,
    fetching: isSessionFetching,
    refetch: refetchSession,
  });
  useSessionSnapshotRecoveryRetry({
    slug,
    sessionId: focusSessionId,
    terminalFailure: focusedError !== null,
    fetching: isFocusedFetching,
    refetch: refetchFocusedSession,
  });
  const focusHitlId = searchParams.get("hitl");
  const focusClientRequestId = searchParams.get("invocation");
  const inspectModelAudit = (messageId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("message", messageId);
    next.set("inspector", "context");
    openInspectorSurface();
    navigate(`?${next.toString()}`);
  };

  useEffect(() => {
    projectLayout?.setSessionInspectorTopInset(inspectorTopInset);
  }, [inspectorTopInset, projectLayout]);

  useEffect(() => () => {
    projectLayout?.setSessionInspectorTopInset(58);
  }, [projectLayout]);

  // Initialize child session store from focused session snapshot
  useEffect(() => {
    if (focusSessionId && focusedSession) {
      const childStore = getWebSessionStore(focusSessionId, slug);
      const result = childStore.getState().applyAuthoritativeSnapshot(
        focusedSession,
        focusedSession.snapshotGeneration,
      );
      if (result === "refresh-required") {
        beginSessionSnapshotRecovery();
        void refetchFocusedSession();
      } else if (result === "stale-generation") {
        void refetchFocusedSession();
      }
    }
  }, [focusSessionId, focusedSession, refetchFocusedSession, slug]);

  useEffect(() => {
    if (!session || session.rootSessionId !== sessionId) return;
    markSessionForeground(slug, rootSessionId, true);
    return () => {
      markSessionForeground(slug, rootSessionId, false);
    };
  }, [rootSessionId, session, slug, sessionId]);

  useEffect(
    () => retainExecutionWorkstreamUiState(slug, rootSessionId),
    [rootSessionId, slug],
  );

  useEffect(() => {
    if (session) {
      const store = getWebSessionStore(sessionId, slug);
      const result = store.getState().applyAuthoritativeSnapshot(
        session,
        session.snapshotGeneration,
      );
      if (result === "refresh-required") {
        beginSessionSnapshotRecovery();
        void refetchSession();
      } else if (result === "stale-generation") {
        void refetchSession();
      }
    }
  }, [refetchSession, session, sessionId, slug]);

  useEffect(() => {
    if (!session || session.rootSessionId === sessionId) return;
    const canonicalSearch = new URLSearchParams(searchParams);
    canonicalSearch.set("focus", session.sessionId);
    const query = canonicalSearch.toString();
    navigate(
      `/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(session.rootSessionId)}${query.length > 0 ? `?${query}` : ""}`,
      { replace: true },
    );
  }, [navigate, searchParams, session, sessionId, slug]);

  useEffect(() => {
    if (!session || session.rootSessionId !== sessionId) return;
    const store = getWebSessionStore(rootSessionId, slug);
    store.getState().setFocusSessionId(focusSessionId);
  }, [focusSessionId, rootSessionId, session, sessionId, slug]);

  useEffect(() => {
    if (!session || session.rootSessionId !== sessionId) return;
    const store = getWebSessionStore(rootSessionId, slug);
    let prev = store.getState().focusSessionId;
    const unsub = store.subscribe((state) => {
      if (state.focusSessionId !== prev) {
        prev = state.focusSessionId;
        const current = new URLSearchParams(window.location.search);
        const currentFocus = current.get("focus") ?? null;
        if (state.focusSessionId !== currentFocus) {
          if (state.focusSessionId) {
            current.set("focus", state.focusSessionId);
          } else {
            current.delete("focus");
          }
          navigate(`?${current.toString()}`, { replace: false });
        }
      }
    });
    return unsub;
  }, [rootSessionId, session, sessionId, slug, navigate]);

  const sessionMissing = sessionError instanceof ApiError
    && sessionError.code === "SESSION_NOT_FOUND";
  useEffect(() => {
    if (!sessionMissing) return;
    navigate(`/projects/${encodeURIComponent(slug)}/sessions`, { replace: true });
  }, [navigate, sessionMissing, slug]);

  if (sessionMissing) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-text-secondary">
        <LoaderCircle
          size={14}
          className="animate-activity text-text-muted"
          aria-hidden="true"
        />
        Returning to project…
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-secondary">
        Failed to load session
      </div>
    );
  }

  if (isSessionLoading || !session || session.rootSessionId !== sessionId) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-text-secondary">
        <LoaderCircle
          size={14}
          className="animate-activity text-text-muted"
          aria-hidden="true"
        />
        Loading session...
      </div>
    );
  }

  if (shellMode === null) {
    return <SessionSourceError>Session source is unavailable.</SessionSourceError>;
  }

  if (shellMode.kind === "todo-bound" && projectTodos.isLoading) {
    return <RouteLoading>Loading linked Todo…</RouteLoading>;
  }

  const linkedTodoFailure = shellMode.kind === "todo-bound"
    ? projectTodos.error !== null
      ? "Could not load the linked Todo."
      : linkedProjectTodo === undefined
        ? "The linked Todo is unavailable."
        : null
    : null;
  if (shellMode.kind === "todo-bound" && linkedTodoFailure !== null) {
    const sourceReturn = sessionSource === undefined
      ? null
      : sessionSourceErrorReturn(sessionSource, slug);
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-base">
        <MissingTodoShell />
        <SessionContextHeader
          slug={slug}
          sessionId={rootSessionId}
          mode={shellMode}
          backLabel={sourceReturn?.label}
          onBack={() => { if (sourceReturn !== null) navigate(sourceReturn.to); }}
          onToggleInspector={toggleInspectorSurface}
          inspectorExpanded={layout.inspectorExpanded}
        />
        <SessionSourceError>{linkedTodoFailure}</SessionSourceError>
      </div>
    );
  }

  const returnToRootCanvas = () => {
    getWebSessionStore(rootSessionId, slug).getState().setFocusSessionId(null);
  };
  const returnFromDiff = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("view");
    next.delete("file");
    navigate(`?${next.toString()}`);
  };
  const returnToSource = () => {
    if (shellMode.kind !== "todo-bound") {
      navigate(shellMode.backTo);
      return;
    }
    const returnState = readTodoWorkReturnState(location.state, shellMode.todoId);
    navigate(
      shellMode.backTo,
      returnState === undefined
        ? undefined
        : { state: createTodoWorkNavigationState(returnState) },
    );
  };
  const focusedCanvas = focusSessionId !== null && canvasView !== "diff";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-base">
      {shellMode.kind === "todo-bound" ? (
        <SelectedTodoShell
          slug={slug}
          todo={linkedProjectTodo!}
          active="work"
          workCount={linkedWorkCount}
        />
      ) : null}
      <SessionContextHeader
        slug={slug}
        sessionId={rootSessionId}
        mode={shellMode}
        onBack={returnToSource}
        onToggleInspector={toggleInspectorSurface}
        inspectorExpanded={layout.inspectorExpanded}
      />
      {canvasView === "diff" ? (
        <div
          className="flex min-h-0 flex-1 flex-col"
          data-testid="session-diff-canvas"
        >
          <div className="min-h-0 flex-1 overflow-hidden">
            <DiffTab
              slug={slug}
              sessionId={rootSessionId}
              selectedPath={selectedFile}
              cwd={session.cwd}
              onBack={returnFromDiff}
            />
          </div>
          <SessionComposerDock
            slug={slug}
            sessionId={rootSessionId}
            focusHitlId={focusHitlId}
            focusComposer={location.state?.focusComposer === true}
            focusClientRequestId={focusClientRequestId}
          />
        </div>
      ) : (
        <div
          className="relative flex min-h-0 flex-1 flex-col"
          data-session-transcript-surface=""
          data-testid="session-transcript-surface"
        >
          {focusedCanvas ? (
            <>
              {focusedError ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-text-secondary">
                  <p className="text-sm">Failed to load sub-agent session</p>
                  <button
                    type="button"
                    className="h-8 rounded-sm border border-border-default bg-bg-elevated px-3 text-[12px] font-medium leading-4 text-text-primary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"
                    onClick={returnToRootCanvas}
                  >
                    Return to root Session
                  </button>
                </div>
              ) : isFocusedLoading || focusedSession === undefined ? (
                <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-text-secondary">
                  <LoaderCircle size={14} className="animate-activity text-text-muted" aria-hidden="true" />
                  Loading sub-agent session…
                </div>
              ) : (
                <ExecutionWorkstream
                  key={focusSessionId}
                  slug={slug}
                  sessionId={focusSessionId}
                  routeScopeId={rootSessionId}
                  sessionIdentity={{
                    agentName: focusedSession.agentName,
                    profile: focusedSession.profile,
                  }}
                  agents={agents}
                  onInspectModelAudit={inspectModelAudit}
                  focusClientRequestId={focusClientRequestId}
                  threadHeader={<FocusedChildSessionHeading session={focusedSession} parentAgentName={session.agentName} agents={agents} onBack={returnToRootCanvas} />}
                />
              )}
            </>
          ) : (
            <ExecutionWorkstream
              key={rootSessionId}
              slug={slug}
              sessionId={rootSessionId}
              routeScopeId={rootSessionId}
              sessionIdentity={{
                agentName: session.agentName,
                profile: session.profile,
              }}
              agents={agents}
              onInspectModelAudit={inspectModelAudit}
              focusClientRequestId={focusClientRequestId}
            />
          )}
          <SessionComposerDock
            slug={slug}
            sessionId={rootSessionId}
            focusHitlId={focusHitlId}
            focusComposer={location.state?.focusComposer === true}
            focusClientRequestId={focusClientRequestId}
          />
        </div>
      )}
    </div>
  );
}

function FocusedChildSessionHeading({
  session,
  parentAgentName,
  agents,
  onBack,
}: {
  session: Session;
  parentAgentName: string;
  agents: readonly AgentDescriptor[];
  onBack: () => void;
}) {
  const execution = session.executions.find(
    (candidate) => candidate.id === session.currentExecutionId,
  ) ?? session.executions.at(-1);
  const executionStatus = execution === undefined
    ? { label: "Ready", detail: undefined }
    : presentExecutionStatus(execution);
  const executionKind = execution === undefined
    ? "idle" as const
    : executionVisualKind(execution);
  const statusTone = statusVisual(executionKind).tone;
  const childDisplayName = resolveAgentDisplayName(session.agentName, agents);
  const parentDisplayName = resolveAgentDisplayName(parentAgentName, agents);
  const childMark = childDisplayName.slice(0, 2).toLocaleUpperCase();
  const childContext = session.delegationRequest?.title ?? session.profile;
  const childMarkTone = session.agentName === "analyst"
    ? "border-info/30 bg-info-muted text-info"
    : session.agentName === "build"
      ? "border-brand/30 bg-brand-subtle text-brand"
      : "border-border-default bg-bg-base text-text-secondary";

  return (
    <section
      className="grid min-h-[57px] grid-cols-[28px_minmax(0,1fr)_auto_auto] items-center gap-2.5 rounded-[7px] border border-border-default bg-bg-elevated px-3 py-2.5 [@media(max-width:720px)]:grid-cols-[28px_minmax(0,1fr)_auto]"
      data-focused-child-heading
      aria-label={`${childDisplayName} child Session`}
    >
      <span
        className={`grid h-7 w-7 place-items-center rounded-[6px] border text-[9.5px] font-bold tracking-[0.01em] ${childMarkTone}`}
        aria-hidden="true"
      >
        {childMark}
      </span>
      <span className="min-w-0">
        <strong className="block truncate text-[12px] font-semibold leading-4 text-text-primary">
          {childDisplayName} Session
        </strong>
        <small className="mt-0.5 block truncate text-[10px] leading-[1.3] text-text-tertiary">
          Child of {parentDisplayName} · {childContext}
        </small>
      </span>
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to Root Session"
        className="inline-flex min-h-8 items-center gap-1.5 rounded-[5px] px-2 text-[10px] text-text-tertiary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(max-width:720px)]:col-[2/-1] [@media(max-width:720px)]:row-start-2 [@media(max-width:720px)]:justify-self-start [@media(pointer:coarse)]:min-h-11"
      >
        <span className="sr-only">Back to Root Session. </span>
        <Eye size={12} className="text-brand" aria-hidden="true" />
        Read-only · Composer stays with {parentDisplayName}
      </button>
      <span
        className={`inline-flex min-h-[23px] items-center gap-1.5 rounded-[5px] border border-border-default px-2 text-[10.5px] font-semibold ${STATUS_SUBTLE_CLASS[statusTone]} ${STATUS_TONE_CLASS[statusTone]}`}
        title={executionStatus.detail ? `${executionStatus.label} · ${executionStatus.detail}` : executionStatus.label}
      >
        <StatusGlyph kind={executionKind} size={12} />
        {executionStatus.label}
      </span>
    </section>
  );
}

function RouteLoading({ children }: { children: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-text-secondary">
      <LoaderCircle size={14} className="animate-activity text-text-muted" aria-hidden="true" />
      {children}
    </div>
  );
}

function SessionSourceError({ children }: { children: string }) {
  return (
    <div className="flex h-full items-center justify-center px-5 text-center text-sm text-error" role="alert" data-testid="session-source-error">
      {children}
    </div>
  );
}

function MissingTodoShell() {
  return (
    <header className="flex min-h-[58px] shrink-0 items-center border-b border-border-default bg-bg-surface px-[18px] [@media(max-width:980px)]:pl-16 [@media(max-width:560px)]:min-h-[88px]" data-selected-todo-shell data-todo-source-error>
      <h1 className="truncate text-[17.5px] font-bold leading-[1.3] tracking-[-0.022em] text-text-primary [@media(max-width:720px)]:text-[14px]">
        Linked Todo unavailable
      </h1>
    </header>
  );
}

function SessionContextHeader({
  slug,
  sessionId,
  mode,
  backLabel,
  onBack,
  onToggleInspector,
  inspectorExpanded,
}: {
  slug: string;
  sessionId: string;
  mode: SessionShellMode;
  backLabel?: string;
  onBack: () => void;
  onToggleInspector: () => void;
  inspectorExpanded: boolean;
}) {
  const title = useSessionStore(sessionId, (state) => state.title, slug);
  const stats = useSessionStore(sessionId, (state) => state.stats, slug);
  const cwd = useSessionStore(sessionId, (state) => state.cwd, slug);
  const executions = useSessionStore(sessionId, (state) => state.executions, slug);
  const currentExecutionId = useSessionStore(sessionId, (state) => state.currentExecutionId, slug);
  const currentExecutionIndex = currentExecutionId === undefined
    ? -1
    : executions.findIndex((execution) => execution.id === currentExecutionId);
  const execution = executions[currentExecutionIndex >= 0 ? currentExecutionIndex : executions.length - 1];
  const executionStatus = execution === undefined
    ? { label: "Ready", detail: undefined }
    : presentExecutionStatus(execution);
  const executionKind = execution === undefined ? "idle" as const : executionVisualKind(execution);
  const statusTone = statusVisual(executionKind).tone;

  return (
    <header
      data-session-context-header
      data-session-shell-mode={mode.kind}
      className={`grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-[11px] border-b border-border-default bg-bg-surface py-1.5 pl-4 pr-3 [@media(max-width:720px)]:px-2 ${mode.kind === "source-only" ? "min-h-[58px]" : "min-h-[50px]"}`}
    >
      <button
        type="button"
        className="inline-flex h-8 items-center gap-[5px] rounded-[5px] px-2 text-[10.5px] text-text-tertiary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(max-width:720px)]:min-h-11 [@media(pointer:coarse)]:min-h-11"
        onClick={onBack}
      >
        <ArrowLeft size={12} strokeWidth={1.7} aria-hidden="true" />
        {backLabel ?? mode.backLabel}
      </button>

      <div className="min-w-0">
        <strong className="block truncate text-[12.5px] font-semibold leading-[1.2] text-text-primary" tabIndex={-1} data-session-title>
          {title ?? "Untitled Session"}
        </strong>
        <small className="mt-0.5 block truncate text-[9.5px] leading-[1.2] text-text-tertiary">
          <span className="[@media(max-width:760px)]:hidden">{mode.sessionKind}</span>
          <span className="[@media(max-width:760px)]:hidden" aria-hidden="true"> · </span>
          {cwd === null ? null : (
            <>
              <span className="[@media(max-width:760px)]:hidden" title={cwd} data-testid="session-cwd">Current checkout: {cwd}</span>
              <span className="[@media(max-width:760px)]:hidden" aria-hidden="true"> · </span>
            </>
          )}
          <span className="font-medium tabular-nums text-text-secondary" data-testid="session-stats">
            {stats.tools.calls.toLocaleString()} tools · {stats.usage.totalTokens.toLocaleString()} tokens
          </span>
          <span className="[@media(max-width:760px)]:hidden" aria-hidden="true"> · </span>
          <span className="[@media(max-width:760px)]:hidden" data-testid="session-source">{mode.sourceLabel}</span>
        </small>
      </div>

      <div className="flex items-center gap-[7px]">
        <span
          data-testid="session-execution-status"
          data-execution-status={execution?.status ?? "ready"}
          title={executionStatus.detail ? `${executionStatus.label} · ${executionStatus.detail}` : executionStatus.label}
          className={`inline-flex min-h-[23px] items-center gap-1.5 rounded-[5px] border border-border-default px-2 text-[10.5px] font-semibold [@media(max-width:720px)]:hidden ${STATUS_SUBTLE_CLASS[statusTone]} ${STATUS_TONE_CLASS[statusTone]}`}
        >
          <StatusGlyph kind={executionKind} size={12} />
          {executionStatus.label}
          {executionStatus.detail ? <span className="font-normal opacity-70">· {executionStatus.detail}</span> : null}
        </span>
        <TodoProgressButton slug={slug} sessionId={sessionId} />
        <InspectorToggleButton expanded={inspectorExpanded} onToggle={onToggleInspector} />
      </div>
    </header>
  );
}
