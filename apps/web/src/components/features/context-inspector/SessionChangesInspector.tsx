import { useNavigate, useSearchParams } from "react-router-dom";
import { InspectorNotice } from "./InspectorPrimitives";
import { buildDiffSearch } from "./session-canvas-navigation";
import type { SessionInspectorProjection } from "./session-inspector-projection";

export function SessionChangesInspector({ projection }: { projection: SessionInspectorProjection["changes"] }) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { files, isLoading, error } = projection;

  if (isLoading) return <InspectorNotice>Loading changes…</InspectorNotice>;
  if (error) return <InspectorNotice tone="error">Failed to load changes</InspectorNotice>;
  if (!files || files.length === 0) return <InspectorNotice>No file changes yet.</InspectorNotice>;
  const hasAggregateDiffstat = files.every((file) => file.additions !== undefined && file.deletions !== undefined);
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const kind = (status: string | undefined): "M" | "A" | "D" => {
    if (status === "created") return "A";
    if (status === "deleted") return "D";
    return "M";
  };
  return (
    <div data-testid="context-changed-files">
      <div className="flex min-h-7 items-center justify-between gap-2.5 px-1.5 pb-2 pt-1 text-[11.5px] font-[560] text-text-tertiary">
        <span><strong className="font-[650] tabular-nums text-text-secondary">{files.length}</strong> files</span>
        {hasAggregateDiffstat && <span><span className="text-success">+{additions}</span> <span className="text-error">−{deletions}</span></span>}
      </div>
      <div className="space-y-px">
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            className="grid min-h-8 w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 rounded-[5px] px-1.5 py-1.5 text-left text-[12px] text-text-secondary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:inset_0_0_0_2px_var(--brand)] [@media(pointer:coarse)]:min-h-11"
            onClick={() => navigate({ search: buildDiffSearch(searchParams, file.path) })}
          >
            <span className={`w-3.5 shrink-0 text-center font-mono text-[11px] font-bold ${file.status === "created" ? "text-success" : file.status === "deleted" ? "text-error" : "text-warning"}`} aria-hidden="true">{kind(file.status)}</span>
            <span className="min-w-0 truncate font-mono text-[11.5px]">{file.path}</span>
            {(file.additions !== undefined || file.deletions !== undefined) && (
              <span className="shrink-0 font-mono text-[11px] tabular-nums">
                <span className="text-success">+{file.additions ?? 0}</span>{" "}
                <span className="text-error">−{file.deletions ?? 0}</span>
              </span>
            )}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="mt-2.5 min-h-[34px] w-full rounded-[6px] border border-border-default px-3 text-[12px] font-semibold text-text-secondary transition-colors duration-[var(--motion-hover)] hover:border-border-strong hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(pointer:coarse)]:min-h-11"
        onClick={() => navigate({ search: buildDiffSearch(searchParams) })}
      >
        Open full diff in canvas
      </button>
    </div>
  );
}
