import { ArrowLeft } from "lucide-react";
import { useLiveSessionDiff } from "../../hooks/use-live-session-diff";
import { DiffView } from "../diff/DiffView";

interface DiffTabProps {
  slug: string;
  sessionId: string;
  selectedPath?: string;
  cwd?: string | null;
  onBack?: () => void;
}

export function DiffTab({ slug, sessionId, selectedPath, cwd, onBack }: DiffTabProps) {
  const { data: files, isLoading, error } = useLiveSessionDiff(slug, sessionId);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-tertiary">Loading diff…</p>
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

  const allFiles = files ?? [];
  const additions = allFiles.reduce((total, file) => total + (file.additions ?? 0), 0);
  const deletions = allFiles.reduce((total, file) => total + (file.deletions ?? 0), 0);
  const fileLabel = `${allFiles.length} ${allFiles.length === 1 ? "file" : "files"} changed`;

  return (
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable_both-edges]">
      <div className="mx-auto w-[calc(100%-32px)] max-w-[900px] pb-[72px] pt-[30px] [@media(max-width:720px)]:pb-12 [@media(max-width:720px)]:pt-[22px]">
        <header className="mb-[22px] flex items-start justify-between gap-[18px]">
          <div className="min-w-0 text-[14px] leading-[21px]">
            <span className="text-[10.5px] font-bold leading-[1.5] uppercase tracking-[0.09em] text-text-tertiary">Current checkout</span>
            <h2 className="mt-0 text-[22px] font-semibold leading-[1.5] tracking-[-0.025em] text-text-primary" tabIndex={-1} data-session-diff-heading>{fileLabel}</h2>
            <p className="mt-1.5 truncate text-[11.5px] leading-[1.5] text-text-tertiary">{cwd ?? "Current checkout"} · working tree for this root Session family</p>
          </div>
          {onBack === undefined ? null : (
            <button type="button" onClick={onBack} className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-[5px] px-2 text-[11px] text-text-tertiary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(pointer:coarse)]:min-h-11">
              <ArrowLeft size={13} aria-hidden="true" /> Session
            </button>
          )}
        </header>
        <div className="mb-5 flex items-end justify-between gap-4">
          <div className="text-[14px] leading-[21px]"><span className="text-[10.5px] font-bold leading-[1.5] uppercase tracking-[0.09em] text-text-tertiary">Working tree</span><h3 className="mb-4 mt-[17px] text-[21px] font-semibold leading-[1.5] text-text-primary">Uncommitted diff</h3></div>
          <div className="flex gap-2.5 font-mono text-[11px]"><span className="text-success">+{additions}</span><span className="text-error">−{deletions}</span></div>
        </div>
        <DiffView files={allFiles} defaultExpandedPath={selectedPath ?? allFiles[0]?.path} selectedPath={selectedPath} className="h-auto overflow-visible [&_[data-diff-file]]:mb-2.5 [&_[data-diff-file]]:overflow-hidden [&_[data-diff-file]]:rounded-lg [&_[data-diff-file]]:border [&_[data-diff-file]]:border-border-default" />
      </div>
    </div>
  );
}
