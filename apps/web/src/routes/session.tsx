import { useEffect } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChatMessages } from "../components/composite/ChatMessages";
import { HitlInbox } from "../components/features/HitlCard";
import { ChatHeader } from "../components/features/ChatHeader";
import { ChatInput } from "../components/features/ChatInput";
import { useFocusedSession, useProjects, useSession } from "../api/queries";
import { useRealtimeHitl } from "../store/hitl-store";
import { getWebSessionStore, markSessionForeground } from "../store/session-store";

export function SessionRoute() {
  const { slug = "", sessionId = "" } = useParams<{
    slug: string;
    sessionId: string;
  }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const { data: session, isLoading: isSessionLoading, error: sessionError } = useSession(slug, sessionId);
  const { data: projects = [] } = useProjects();
  const projectRoot = projects.find((project) => project.slug === slug)?.workspaceRoot;
  const rootSessionId = session?.rootSessionId ?? sessionId;
  const focusSessionId = searchParams.get("focus");
  const { data: focusedSession, isLoading: isFocusedLoading, error: focusedError } = useFocusedSession(slug, focusSessionId);
  const sessionHitl = useRealtimeHitl({
    slug,
    scope: "session",
    ownerId: session?.rootSessionId,
    includeChildren: true,
  });
  const focusedHitl = useRealtimeHitl({
    slug,
    scope: "session",
    ownerId: focusSessionId ?? undefined,
    includeChildren: true,
  });

  // Initialize child session store from focused session snapshot
  useEffect(() => {
    if (focusSessionId && focusedSession) {
      const childStore = getWebSessionStore(focusSessionId, slug);
      const {
        messages,
        steps,
        todos,
        title,
        createdAt,
        rootSessionId,
        parentSessionId,
        agentName,
        stats,
        executions,
        childSessionLinks,
        eventCursor,
        modelInfo,
        cwd,
      } = focusedSession;
      childStore.getState().initializeFromSnapshot({
        messages,
        steps,
        todos,
        title,
        createdAt,
        rootSessionId,
        parentSessionId,
        agentName,
        stats,
        executions,
        childSessionLinks,
        eventCursor,
        modelInfo,
        cwd,
      });
    }
  }, [focusSessionId, focusedSession, slug]);

  useEffect(() => {
    if (!session || session.rootSessionId !== sessionId) return;
    markSessionForeground(slug, rootSessionId, true);
    return () => {
      markSessionForeground(slug, rootSessionId, false);
    };
  }, [rootSessionId, session, slug, sessionId]);

  useEffect(() => {
    if (session) {
      const store = getWebSessionStore(sessionId, slug);
      const {
        messages,
        steps,
        todos,
        title,
        createdAt,
        rootSessionId,
        parentSessionId,
        agentName,
        stats,
        executions,
        childSessionLinks,
        eventCursor,
        modelInfo,
        cwd,
      } = session;
      store.getState().initializeFromSnapshot({
        messages,
        steps,
        todos,
        title,
        createdAt,
        rootSessionId,
        parentSessionId,
        agentName,
        stats,
        executions,
        childSessionLinks,
        eventCursor,
        modelInfo,
        cwd,
      });
    }
  }, [session, sessionId, slug]);

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
        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-text-muted border-t-transparent" />
        Loading session...
      </div>
    );
  }

  // Focused view: breadcrumb bar + child session messages (read-only)
  if (focusSessionId) {
    const rootTitle = session?.title ?? "Session";
    const childTitle = focusedError
      ? "Error"
      : isFocusedLoading
        ? "Loading..."
        : focusedSession?.title ?? focusSessionId;

    const handleReturn = () => {
      const store = getWebSessionStore(rootSessionId, slug);
      store.getState().setFocusSessionId(null);
    };

    return (
      <div className="flex h-full flex-col">
        <div className="bg-bg-elevated border-b border-border-subtle px-3.5 py-2 flex items-center justify-between text-[13px]">
          <button
            type="button"
            className="text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
            onClick={handleReturn}
          >
            ← Back to {rootTitle}
          </button>
          <span className="text-text-primary font-medium truncate ml-4">
            {childTitle}
          </span>
        </div>
        {focusedError ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-secondary">
            <p className="text-sm">Failed to load sub-agent session</p>
            <button
              type="button"
              className="text-xs px-3 py-1.5 rounded-md bg-bg-elevated border border-border-subtle text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              onClick={handleReturn}
            >
              Return to session
            </button>
          </div>
        ) : isFocusedLoading ? (
          <div className="flex-1 flex items-center justify-center text-text-secondary text-sm gap-2">
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-text-muted border-t-transparent" />
            Loading sub-agent session...
          </div>
        ) : (
          <>
            <ChatMessages slug={slug} sessionId={focusSessionId} />
            <HitlInbox
              projections={focusedHitl}
              hideWhenEmpty
              className="gap-2 shrink-0 border-t border-border-subtle bg-bg-surface px-5 py-3"
            />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ChatHeader
        slug={slug}
        sessionId={rootSessionId}
        goalId={session?.goalId}
        projectRoot={projectRoot}
        onToggleDetail={() => {}}
      />
      <ChatMessages slug={slug} sessionId={rootSessionId} />
      <HitlInbox
        projections={sessionHitl}
        hideWhenEmpty
        className="gap-2 shrink-0 border-t border-border-subtle bg-bg-surface px-5 py-3"
      />
      <ChatInput slug={slug} sessionId={rootSessionId} />
    </div>
  );
}
