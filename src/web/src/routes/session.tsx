import { useParams } from "react-router-dom";
import { ChatHeader } from "../components/features/ChatHeader";
import { ChatInput } from "../components/features/ChatInput";
import { PipelineStepper } from "../components/features/PipelineStepper";

export function SessionRoute() {
  const { slug = "", sessionId = "" } = useParams<{
    slug: string;
    sessionId: string;
  }>();

  return (
    <div className="flex h-full flex-col">
      <ChatHeader
        slug={slug}
        sessionId={sessionId}
        onToggleDetail={() => {}}
      />
      <PipelineStepper slug={slug} sessionId={sessionId} />
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-text-tertiary">Chat placeholder</p>
      </div>
      <ChatInput slug={slug} sessionId={sessionId} />
    </div>
  );
}