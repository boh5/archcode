import { useParams } from "react-router-dom";

export function SessionRoute() {
  const { slug, sessionId } = useParams<{
    slug: string;
    sessionId: string;
  }>();

  return (
    <div className="grid h-screen grid-cols-[240px_1fr_1fr_280px] bg-bg-base">
      <aside className="flex flex-col border-r border-border-default bg-bg-surface">
        <div className="flex h-10 items-center border-b border-border-default px-3">
          <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
            {slug}
          </span>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          <div className="rounded-md px-3 py-2 text-sm text-text-tertiary">
            Sidebar placeholder
          </div>
        </nav>
      </aside>

      <section className="flex flex-col border-r border-border-default bg-bg-surface">
        <div className="flex h-10 items-center border-b border-border-default px-3">
          <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
            Sessions
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          <div className="rounded-md px-3 py-2 text-sm text-text-tertiary">
            Session list placeholder
          </div>
        </div>
      </section>

      <main className="flex flex-col">
        <div className="flex h-10 items-center border-b border-border-default px-4">
          <span className="text-xs font-medium text-text-secondary">
            Session: {sessionId}
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-text-tertiary">Chat placeholder</p>
        </div>
      </main>

      <aside className="flex flex-col border-l border-border-default bg-bg-surface">
        <div className="flex h-10 items-center border-b border-border-default px-3">
          <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
            Details
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          <div className="rounded-md px-3 py-2 text-sm text-text-tertiary">
            Details placeholder
          </div>
        </div>
      </aside>
    </div>
  );
}