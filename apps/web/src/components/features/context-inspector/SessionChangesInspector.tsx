import { FileCode2 } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useLiveSessionDiff } from "../../../hooks/use-live-session-diff";
import { InspectorNotice } from "./InspectorPrimitives";
import { buildDiffSearch } from "./session-canvas-navigation";

export function SessionChangesInspector() {
  const { slug = "", sessionId = "" } = useParams<{ slug: string; sessionId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const fullDiffOpen = searchParams.get("view") === "diff";
  const { data: files, isLoading, error } = useLiveSessionDiff(slug, sessionId, !fullDiffOpen);

  if (isLoading) return <InspectorNotice>Loading changes…</InspectorNotice>;
  if (error) return <InspectorNotice tone="error">Failed to load changes</InspectorNotice>;
  if (!files || files.length === 0) return <InspectorNotice>No changed files</InspectorNotice>;
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  return (
    <div data-testid="context-changed-files">
      <div className="mb-2 flex items-center justify-between text-xs text-text-tertiary">
        <span>{files.length} files</span>
        <span><span className="text-success">+{additions}</span> <span className="text-error">−{deletions}</span></span>
      </div>
      <div className="space-y-1">
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            onClick={() => navigate({ search: buildDiffSearch(searchParams, file.path) })}
          >
            <FileCode2 size={13} className="shrink-0 text-text-muted" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
            <span className="shrink-0 text-[11px] text-text-tertiary">{file.status ?? "modified"}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="mt-3 w-full rounded-sm border border-border-default px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        onClick={() => navigate({ search: buildDiffSearch(searchParams) })}
      >
        Open full diff in canvas
      </button>
    </div>
  );
}
