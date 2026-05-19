import { useParams } from "react-router-dom";
import { ChatMessages } from "../components/composite/ChatMessages";
import { ChatHeader } from "../components/features/ChatHeader";
import { ChatInput } from "../components/features/ChatInput";
import { PipelineStepper } from "../components/features/PipelineStepper";
import { useSessionEvents } from "../hooks/use-session-events";

export function SessionRoute() {
  const { slug = "", sessionId = "" } = useParams<{
    slug: string;
    sessionId: string;
  }>();

  useSessionEvents(slug, sessionId);

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