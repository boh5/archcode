import { Bell, ExternalLink, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { hitlAttentionPath, scopedHitlIdentity, type ScopedHitlView } from "../../store/hitl-store";
import { formatRelativeTime } from "../../lib/time-format";

export function hitlAttentionLink(entry: ScopedHitlView): string {
  return hitlAttentionPath(entry);
}

export function HitlAttentionList({
  entries,
  emptyMessage = "No requests need your attention",
  title = "Needs attention",
  maxItems,
  showProject = false,
  testId = "hitl-attention-list",
  footer,
  onOpen,
}: {
  entries: readonly ScopedHitlView[];
  emptyMessage?: string;
  title?: string;
  maxItems?: number;
  showProject?: boolean;
  testId?: string;
  footer?: ReactNode;
  onOpen?: () => void;
}) {
  const visible = maxItems === undefined ? entries : entries.slice(0, maxItems);
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <div className="flex items-center gap-2">
        <Bell size={13} className="text-warning" aria-hidden="true" />
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{title}</h3>
        {entries.length > 0 && <span className="text-xs text-text-muted">{entries.length}</span>}
      </div>
      {visible.length === 0 ? (
        <p className="py-2 text-xs text-text-muted">{emptyMessage}</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-1.5">
          {visible.map((entry) => {
            const inspection = entry.view.requiresInspection === true;
            return (
              <Link
                key={scopedHitlIdentity(entry)}
                to={hitlAttentionLink(entry)}
                className={`group flex min-w-0 items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${inspection
                  ? "border-error/50 bg-error-muted/40 hover:border-error"
                  : "border-warning/40 bg-warning-muted/30 hover:border-warning"
                }`}
                data-testid="hitl-attention-open"
                data-hitl-id={entry.view.hitlId}
                onClick={onOpen}
              >
                {inspection ? <TriangleAlert size={14} className="mt-0.5 shrink-0 text-error" aria-hidden="true" /> : <Bell size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />}
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-xs font-medium text-text-primary">{entry.view.displayPayload.title}</span>
                  <span className="mt-0.5 block text-[11px] text-text-muted">
                    {inspection ? "Manual inspection required" : entry.view.source.type === "ask_user" ? "Question waiting" : "Permission waiting"}
                    {showProject ? ` · ${entry.projectSlug}` : ""} · {formatRelativeTime(Date.parse(entry.view.createdAt))}
                  </span>
                </span>
                <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-accent">Open <ExternalLink size={11} /></span>
              </Link>
            );
          })}
        </div>
      )}
      {footer}
    </section>
  );
}
