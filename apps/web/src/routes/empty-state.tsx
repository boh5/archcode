export function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-lg font-medium text-text-primary">
          Select a project
        </h2>
        <p className="text-sm text-text-tertiary">
          Choose a project from the sidebar or add a new one
        </p>
      </div>
    </div>
  );
}