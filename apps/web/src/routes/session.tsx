import { useEffect, useRef } from "react";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ExecutionWorkstream,
  retainExecutionWorkstreamUiState,
} from "../components/composite/ExecutionWorkstream";
import { ChatHeader } from "../components/features/ChatHeader";
import { SessionComposerDock } from "../components/features/SessionComposerDock";
import { DiffTab } from "../components/features/DiffTab";
import { TodoProgressButton } from "../components/features/TodoProgressButton";
import { InspectorToggleButton } from "../components/features/InspectorToggleButton";
import { SidebarToggleButton } from "../components/features/SidebarToggleButton";
import { useAgents, useFocusedSession, useProjectTodos, useSession } from "../api/queries";
import {
  beginSessionSnapshotRecovery,
  getWebSessionStore,
  markSessionForeground,
} from "../store/session-store";
import { useWorkbenchLayout } from "../context/workbench-layout";
import {
  createSessionSnapshotRecoveryRetry,
  type SessionSnapshotRecoveryRetry,
  type SessionSnapshotRequestState,
} from "../lib/session-snapshot-recovery-retry";
import { ApiError } from "../api/client";

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

export function SessionRoute() {
  const { slug = "", sessionId = "" } = useParams<{
    slug: string;
    sessionId: string;
  }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const layout = useWorkbenchLayout();
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
  const { data: projectTodos = [] } = useProjectTodos(slug);
  const { data: agents = [] } = useAgents();
  const rootSessionId = session?.rootSessionId ?? sessionId;
  const sessionSource = session?.projectTodo;
  const linkedProjectTodo = sessionSource
    ? projectTodos.find((todo) => todo.id === sessionSource.todoId)
    : undefined;
  const linkedProjectTodoContext = sessionSource?.entry === "discussion"
    ? "Discussion Todo"
    : sessionSource?.entry === "automation"
      ? "Automation setup Todo"
      : "Work Todo";
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
  const inspectModelAudit = (messageId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("message", messageId);
    next.set("inspector", "context");
    openInspectorSurface();
    navigate(`?${next.toString()}`);
  };

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
    navigate(`/projects/${encodeURIComponent(slug)}`, { replace: true });
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

  // Focused view: breadcrumb bar + child session messages (read-only)
  if (focusSessionId && canvasView !== "diff") {
    const rootTitle = session?.title ?? "Session";
    const childTitle = focusedError
      ? "Error"
      : isFocusedLoading
        ? "Loading..."
        : (focusedSession?.title ?? focusSessionId);

    const handleReturn = () => {
      const store = getWebSessionStore(rootSessionId, slug);
      store.getState().setFocusSessionId(null);
    };

    return (
      <div className="flex h-full flex-col">
        <div className="flex min-h-16 items-center justify-between gap-3 border-b border-border-default bg-bg-surface px-4 py-2 text-[13px] sm:px-5">
          <SidebarToggleButton />
          <button
            type="button"
            className="inline-flex items-center gap-1 text-text-secondary transition-colors duration-[var(--motion-hover)] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            onClick={handleReturn}
          >
            <ArrowLeft size={13} aria-hidden="true" /> Back to {rootTitle}
          </button>
          <span className="min-w-0 flex-1 truncate text-right font-medium text-text-primary">
            {childTitle}
          </span>
          <TodoProgressButton slug={slug} sessionId={focusSessionId} />
          <InspectorToggleButton
            expanded={layout.inspectorExpanded}
            onToggle={toggleInspectorSurface}
          />
        </div>
        {focusedError ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-secondary">
            <p className="text-sm">Failed to load sub-agent session</p>
            <button
              type="button"
              className="h-8 rounded-sm border border-border-default bg-bg-elevated px-3 text-[12px] font-medium leading-4 text-text-primary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              onClick={handleReturn}
            >
              Return to session
            </button>
          </div>
        ) : isFocusedLoading ? (
          <div className="flex-1 flex items-center justify-center text-text-secondary text-sm gap-2">
            <LoaderCircle
              size={14}
              className="animate-activity text-text-muted"
              aria-hidden="true"
            />
            Loading sub-agent session...
          </div>
        ) : (
          <div
            className="relative flex min-h-0 flex-1 flex-col"
            data-session-transcript-surface=""
            data-testid="session-transcript-surface"
          >
            <ExecutionWorkstream
              key={focusSessionId}
              slug={slug}
              sessionId={focusSessionId}
              routeScopeId={rootSessionId}
              sessionIdentity={{
                agentName: focusedSession!.agentName,
                profile: focusedSession!.profile,
              }}
              agents={agents}
              onInspectModelAudit={inspectModelAudit}
            />
            <SessionComposerDock
              slug={slug}
              sessionId={rootSessionId}
              focusHitlId={focusHitlId}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ChatHeader
        slug={slug}
        sessionId={rootSessionId}
        source={
          linkedProjectTodo
            ? {
                label: linkedProjectTodoContext,
                title: linkedProjectTodo.title,
                to: `/projects/${encodeURIComponent(slug)}/todos?todo=${encodeURIComponent(linkedProjectTodo.id)}`,
              }
            : undefined
        }
        onToggleInspector={toggleInspectorSurface}
        inspectorExpanded={layout.inspectorExpanded}
      />
      {canvasView === "diff" ? (
        <div
          className="flex min-h-0 flex-1 flex-col"
          data-testid="session-diff-canvas"
        >
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-default bg-bg-surface px-4">
            <button
              type="button"
              className="flex items-center gap-1 text-[12px] text-text-tertiary transition-colors duration-[var(--motion-hover)] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete("view");
                next.delete("file");
                navigate(`?${next.toString()}`);
              }}
            >
              <ArrowLeft size={13} />
              Execution
            </button>
            <span className="text-text-muted" aria-hidden="true">
              /
            </span>
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">
              {selectedFile ?? "All changes"}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <DiffTab
              slug={slug}
              sessionId={rootSessionId}
              selectedPath={selectedFile}
            />
          </div>
        </div>
      ) : (
        <div
          className="relative flex min-h-0 flex-1 flex-col"
          data-session-transcript-surface=""
          data-testid="session-transcript-surface"
        >
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
          />
          <SessionComposerDock
            slug={slug}
            sessionId={rootSessionId}
            focusHitlId={focusHitlId}
          />
        </div>
      )}
    </div>
  );
}
