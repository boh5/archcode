import { useLiveSessionDiff } from "../../hooks/use-live-session-diff";
import { DiffView } from "../diff/DiffView";

interface DiffTabProps {
  slug: string;
  sessionId: string;
  selectedPath?: string;
}

export function DiffTab({ slug, sessionId, selectedPath }: DiffTabProps) {
  const { data: files, isLoading, error } = useLiveSessionDiff(slug, sessionId);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-muted">Loading diff…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-error">Failed to load diff</p>
      </div>
    );
  }

  const visibleFiles = selectedPath
    ? (files ?? []).filter((file) => file.path === selectedPath)
    : (files ?? []);

  return <DiffView files={visibleFiles} defaultExpanded={Boolean(selectedPath)} />;
}
