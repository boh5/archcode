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
    <section data-testid="context-changed-files">
      <span className="block text-[10.5px] font-bold uppercase leading-[21px] tracking-[0.09em] text-text-tertiary">Current checkout</span>
      <p className="mb-3 mt-1 text-[10.5px] leading-[1.45] text-text-tertiary">Working tree for this root Session family. It is not an aggregate Todo diff.</p>
      <dl className={`mb-3 mt-2.5 grid overflow-hidden rounded-[6px] border border-border-default ${hasAggregateDiffstat ? "grid-cols-3" : "grid-cols-1"}`}>
        <div className="border-border-default bg-bg-muted p-2 [&:not(:last-child)]:border-r"><dt className="text-[10.5px] uppercase tracking-[0.07em] text-text-tertiary">Files</dt><dd className="mt-1 font-mono text-[11px] font-semibold leading-none text-text-secondary">{files.length}</dd></div>
        {hasAggregateDiffstat ? <>
          <div className="border-r border-border-default bg-bg-muted p-2"><dt className="text-[10.5px] uppercase tracking-[0.07em] text-text-tertiary">Additions</dt><dd className="mt-1 font-mono text-[11px] font-semibold leading-none text-success">+{additions}</dd></div>
          <div className="bg-bg-muted p-2"><dt className="text-[10.5px] uppercase tracking-[0.07em] text-text-tertiary">Deletions</dt><dd className="mt-1 font-mono text-[11px] font-semibold leading-none text-error">−{deletions}</dd></div>
        </> : null}
      </dl>
      <div>
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            className="grid min-h-10 w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 border-b border-border-subtle text-left text-text-secondary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:inset_0_0_0_2px_var(--brand)] [@media(pointer:coarse)]:min-h-11"
            onClick={() => navigate({ search: buildDiffSearch(searchParams, file.path) })}
          >
            <span className={`w-4 shrink-0 text-center font-mono text-[10.5px] font-bold ${file.status === "created" ? "text-success" : file.status === "deleted" ? "text-error" : "text-warning"}`} aria-hidden="true">{kind(file.status)}</span>
            <span className="min-w-0"><span className="block truncate font-mono text-[11.5px] font-semibold leading-[1.3] text-text-primary">{file.path}</span><span className="mt-0.5 block text-[11px] leading-[1.2] text-text-tertiary">{file.status === "created" ? "Added" : file.status === "deleted" ? "Deleted" : "Modified"}</span></span>
            {(file.additions !== undefined || file.deletions !== undefined) && (
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-tertiary">
                <span className="text-success">+{file.additions ?? 0}</span>{" "}
                <span className="text-error">−{file.deletions ?? 0}</span>
              </span>
            )}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="mt-3 min-h-[34px] w-full border-t border-border-default text-left text-[10.5px] font-semibold text-brand transition-colors duration-[var(--motion-fast)] hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(pointer:coarse)]:min-h-11"
        onClick={() => navigate({ search: buildDiffSearch(searchParams) })}
      >
        Open full diff
      </button>
    </section>
  );
}
