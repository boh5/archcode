import { useEffect } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChatMessages } from "../components/composite/ChatMessages";
import { AttentionQueue } from "../components/features/AttentionQueue";
import { ChatHeader } from "../components/features/ChatHeader";
import { ChatInput } from "../components/features/ChatInput";
import { PipelineStepper } from "../components/features/PipelineStepper";
import { useFocusedSession, useSession } from "../api/queries";
import { getWebSessionStore, markSessionForeground, useSessionStore } from "../store/session-store";

export function SessionRoute() {
  const { slug = "", sessionId = "" } = useParams<{
    slug: string;
    sessionId: string;
  }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const { data: session } = useSession(slug, sessionId);
  const focusSessionId = useSessionStore(sessionId, (s) => s.focusSessionId, slug);
  const { data: focusedSession, isLoading: isFocusedLoading, error: focusedError } = useFocusedSession(slug, focusSessionId);

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
        stats,
        executions,
        eventCursor,
      } = focusedSession;
      childStore.getState().initializeFromSnapshot({
        messages,
        steps,
        todos,
        title,
        createdAt,
        rootSessionId,
        parentSessionId,
        stats,
        executions,
        eventCursor,
      });
    }
  }, [focusSessionId, focusedSession, slug]);

  useEffect(() => {
    markSessionForeground(slug, sessionId, true);
    return () => {
      markSessionForeground(slug, sessionId, false);
    };
  }, [slug, sessionId]);

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
        stats,
        executions,
        eventCursor,
      } = session;
      store.getState().initializeFromSnapshot({
        messages,
        steps,
        todos,
        title,
        createdAt,
        rootSessionId,
        parentSessionId,
        stats,
        executions,
        eventCursor,
      });
    }
  }, [session, sessionId, slug]);

  useEffect(() => {
    const focusId = searchParams.get("focus") ?? null;
    const store = getWebSessionStore(sessionId, slug);
    store.getState().setFocusSessionId(focusId);
  }, [searchParams, sessionId, slug]);

  useEffect(() => {
    const store = getWebSessionStore(sessionId, slug);
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
  }, [sessionId, slug, navigate]);

  // Focused view: breadcrumb bar + child session messages (read-only)
  if (focusSessionId) {
    const rootTitle = session?.title ?? "Session";
    const childTitle = focusedError
      ? "Error"
      : isFocusedLoading
        ? "Loading..."
        : focusedSession?.title ?? focusSessionId;

    const handleReturn = () => {
      const store = getWebSessionStore(sessionId, slug);
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
          <ChatMessages slug={slug} sessionId={focusSessionId} />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ChatHeader
        slug={slug}
        sessionId={sessionId}
        onToggleDetail={() => {}}
      />
      <PipelineStepper slug={slug} sessionId={sessionId} />
      <ChatMessages slug={slug} sessionId={sessionId} />
      <AttentionQueue slug={slug} sessionId={sessionId} />
      <ChatInput slug={slug} sessionId={sessionId} />
    </div>
  );
}
