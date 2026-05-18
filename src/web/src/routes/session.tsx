import { useParams } from "react-router-dom";
import { AppLayout } from "../layout/AppLayout";

export function SessionRoute() {
  const { slug, sessionId } = useParams<{
    slug: string;
    sessionId: string;
  }>();

  return (
    <AppLayout
      header={
        <div className="flex h-full items-center border-b border-border-subtle bg-bg-surface px-4">
          <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
            Session: {sessionId}
          </span>
        </div>
      }
      projectBar={
        <div className="flex h-full flex-col items-center border-r border-border-subtle bg-bg-surface py-2">
          <div className="text-xs font-medium text-text-tertiary">PB</div>
        </div>
      }
      sidebar={
        <div className="flex h-full flex-col border-r border-border-subtle bg-bg-surface">
          <div className="flex h-10 items-center border-b border-border-subtle px-3">
            <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
              {slug}
            </span>
          </div>
          <nav className="flex-1 overflow-y-auto p-2">
            <div className="rounded-md px-3 py-2 text-sm text-text-tertiary">
              Sidebar placeholder
            </div>
          </nav>
        </div>
      }
      chat={
        <div className="flex h-full flex-col bg-bg-base">
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-text-tertiary">Chat placeholder</p>
          </div>
        </div>
      }
      detailPanel={
        <div className="flex h-full flex-col border-l border-border-subtle bg-bg-surface">
          <div className="flex h-10 items-center border-b border-border-subtle px-3">
            <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
              Details
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            <div className="rounded-md px-3 py-2 text-sm text-text-tertiary">
              Details placeholder
            </div>
          </div>
        </div>
      }
    />
  );
}