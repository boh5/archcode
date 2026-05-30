import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { ChatMessages } from "../components/composite/ChatMessages";
import { AttentionQueue } from "../components/features/AttentionQueue";
import { ChatHeader } from "../components/features/ChatHeader";
import { ChatInput } from "../components/features/ChatInput";
import { PipelineStepper } from "../components/features/PipelineStepper";
import { useSession } from "../api/queries";
import { getWebSessionStore, markSessionForeground } from "../store/session-store";

export function SessionRoute() {
  const { slug = "", sessionId = "" } = useParams<{
    slug: string;
    sessionId: string;
  }>();

  const { data: session } = useSession(slug, sessionId);

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
        runs,
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
        runs,
        eventCursor,
      });
    }
  }, [session, sessionId, slug]);

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
