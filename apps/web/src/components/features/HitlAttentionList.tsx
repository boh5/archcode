import { Bell, ChevronRight, ExternalLink, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { hitlAttentionPath, scopedHitlIdentity, type ScopedHitlView } from "../../store/hitl-store";
import { StatusGlyph } from "../primitives/StatusGlyph";
import { RelativeTime } from "../primitives/TemporalText";

export function hitlAttentionLink(entry: ScopedHitlView): string {
  return hitlAttentionPath(entry);
}

export function HitlAttentionList({
  entries,
  emptyMessage = "Nothing needs you",
  title = "Needs you",
  maxItems,
  showProject = false,
  testId = "hitl-attention-list",
  footer,
  onOpen,
  popover = false,
}: {
  entries: readonly ScopedHitlView[];
  emptyMessage?: string;
  title?: string;
  maxItems?: number;
  showProject?: boolean;
  testId?: string;
  footer?: ReactNode;
  onOpen?: () => void;
  popover?: boolean;
}) {
  const visible = maxItems === undefined ? entries : entries.slice(0, maxItems);
  if (popover) return <section className="min-w-0" data-testid={testId}>
    {visible.length === 0 ? <p className="flex min-h-[58px] items-center px-3 text-[11.5px] text-text-tertiary">{emptyMessage}</p> : visible.map((entry) => {
      const inspection = entry.view.requiresInspection === true;
      return <Link
        key={scopedHitlIdentity(entry)}
        to={hitlAttentionLink(entry)}
        className="grid min-h-[58px] min-w-0 grid-cols-[28px_minmax(0,1fr)_14px] items-center gap-[9px] border-b border-border-default px-3 py-2 text-left text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
        data-testid="hitl-attention-open"
        data-hitl-id={entry.view.hitlId}
        onClick={onOpen}
      >
        <span className={`grid h-[27px] w-[27px] place-items-center rounded-[7px] border ${inspection ? "border-error/40 bg-error-muted text-error" : "border-warning/40 bg-warning-muted text-warning"}`}>
          {inspection ? <TriangleAlert size={12} aria-hidden="true" /> : <StatusGlyph kind="needs_you" label="Needs you" size={12} />}
        </span>
        <span className="min-w-0"><strong className="block truncate text-[12px] font-semibold text-text-primary">{entry.view.displayPayload.title}</strong><small className="mt-[3px] block truncate text-[10.5px] text-text-tertiary">{inspection ? "Manual inspection required" : entry.view.source.type === "ask_user" ? "Question waiting" : "Permission waiting"}{showProject ? ` · ${entry.projectSlug}` : ""}</small></span>
        <ChevronRight size={14} className="text-text-muted" aria-hidden="true" />
      </Link>;
    })}
    {footer}
  </section>;
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <div className="flex items-center gap-2">
        <Bell size={13} className="text-warning" aria-hidden="true" />
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{title}</h3>
        {entries.length > 0 && <span className="text-[10px] font-semibold leading-[14px] text-text-tertiary">{entries.length}</span>}
      </div>
      {visible.length === 0 ? (
        <p className="py-2 text-xs text-text-tertiary">{emptyMessage}</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          {visible.map((entry) => {
            const inspection = entry.view.requiresInspection === true;
            return (
              <Link
                key={scopedHitlIdentity(entry)}
                to={hitlAttentionLink(entry)}
                className={`group flex min-w-0 items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors ${inspection
                  ? "border-error/50 bg-error-muted hover:border-error"
                  : "border-warning/40 bg-warning-muted hover:border-warning"
                }`}
                data-testid="hitl-attention-open"
                data-hitl-id={entry.view.hitlId}
                onClick={onOpen}
              >
                {inspection ? <TriangleAlert size={14} className="mt-1 shrink-0 text-error" aria-hidden="true" /> : <StatusGlyph kind="needs_you" label="Needs you" size={14} className="mt-1" />}
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-xs font-medium text-text-primary">{entry.view.displayPayload.title}</span>
                  <span className="mt-1 block text-[11px] text-text-tertiary">
                    {inspection ? "Manual inspection required" : entry.view.source.type === "ask_user" ? "Question waiting" : "Permission waiting"}
                    {showProject ? ` · ${entry.projectSlug}` : ""} · <RelativeTime timestamp={Date.parse(entry.view.createdAt)} />
                  </span>
                </span>
                <span className="mt-1 inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-brand">Open <ExternalLink size={11} /></span>
              </Link>
            );
          })}
        </div>
      )}
      {footer}
    </section>
  );
}
