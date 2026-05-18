import { useParams, Outlet } from "react-router-dom";

export function ProjectRoute() {
  const { slug } = useParams<{ slug: string }>();

  return (
    <div className="flex h-screen bg-bg-base">
      <aside className="flex w-60 flex-col border-r border-border-default bg-bg-surface">
        <div className="flex h-10 items-center border-b border-border-default px-3">
          <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
            Sessions
          </span>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          <div className="rounded-md px-3 py-2 text-sm text-text-tertiary">
            No sessions yet
          </div>
        </nav>
      </aside>

      <main className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-lg font-medium text-text-primary">
            Project: {slug}
          </h2>
          <p className="text-sm text-text-tertiary">
            Select or create a session to begin
          </p>
        </div>
        <Outlet />
      </main>
    </div>
  );
}