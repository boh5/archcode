import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ChatMessages } from "../components/composite/ChatMessages";
import { ChatHeader } from "../components/features/ChatHeader";
import { ChatInput } from "../components/features/ChatInput";
import { PipelineStepper } from "../components/features/PipelineStepper";
import { useSessionEvents } from "../hooks/use-session-events";
import { useSession, queryKeys } from "../api/queries";
import { getWebSessionStore } from "../store/session-store";

export function SessionRoute() {
  const { slug = "", sessionId = "" } = useParams<{
    slug: string;
    sessionId: string;
  }>();

  const { data: session } = useSession(slug, sessionId);
  const queryClient = useQueryClient();

  useSessionEvents(slug, sessionId, {
    eventCursor: session?.eventCursor,
    onReset: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.session(slug, sessionId) });
    },
  });

  useEffect(() => {
    if (session) {
      const store = getWebSessionStore(sessionId, slug);
      store.getState().initializeFromSnapshot(session as never);
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
      <ChatInput slug={slug} sessionId={sessionId} />
    </div>
  );
}