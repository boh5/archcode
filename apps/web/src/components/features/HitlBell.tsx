import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, X } from "lucide-react";
import { useAttentionVisibleScopedHitl } from "../../store/hitl-store";
import { HitlAttentionList } from "./HitlAttentionList";

export function HitlBell({ mobile = false }: { mobile?: boolean }) {
  const entries = useAttentionVisibleScopedHitl();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  /** Every dismissal returns keyboard control to the stable Bell trigger. */
  const close = useCallback(() => {
    setOpen(false);
    queueMicrotask(() => buttonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, open]);
  const requestBrowserNotifications = () => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
  };

  return (
    <div className={mobile ? "relative" : "relative flex w-full justify-center"}>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Open requests needing attention"
        aria-expanded={open}
        aria-controls="hitl-bell-panel"
        className="relative flex h-8 w-8 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
      >
        <Bell size={16} aria-hidden="true" />
        {entries.length > 0 && <span className="absolute -right-1 -top-1 grid min-h-4 min-w-4 place-items-center rounded-full bg-warning px-1 text-[9px] font-bold text-bg-base" aria-label={`${entries.length} requests need attention`}>{entries.length > 99 ? "99+" : entries.length}</span>}
      </button>
      {open && <>
        {mobile && <button type="button" aria-label="Close requests needing attention" className="fixed inset-0 z-40 bg-black/60" onClick={close} />}
        <section
          id="hitl-bell-panel"
          role="dialog"
          aria-label="Requests needing attention"
          className={mobile
            ? "fixed inset-x-2 bottom-2 z-50 max-h-[min(76vh,560px)] overflow-y-auto rounded-xl border border-border-default bg-bg-elevated p-3 shadow-xl"
            : "absolute bottom-10 left-10 z-50 w-[min(360px,calc(100vw-1rem))] rounded-xl border border-border-default bg-bg-elevated p-3 shadow-xl"
          }
        >
          <div className="mb-1 flex justify-end"><button type="button" aria-label="Close requests needing attention" className="flex h-6 w-6 items-center justify-center rounded-sm text-text-muted hover:bg-bg-hover" onClick={close}><X size={14} /></button></div>
          <HitlAttentionList
            entries={entries}
            maxItems={10}
            showProject
            footer={<BellFooter onRequestBrowserNotifications={requestBrowserNotifications} />}
            onOpen={close}
          />
        </section>
      </>}
    </div>
  );
}

function BellFooter({ onRequestBrowserNotifications }: { onRequestBrowserNotifications: () => void }) {
  return (
    <div className="mt-1 flex items-center justify-between gap-2 border-t border-border-subtle pt-2">
      <a href="/#needs-attention" className="text-xs font-medium text-accent hover:text-accent-hover">View all</a>
      {typeof Notification !== "undefined" && Notification.permission === "default" && <button type="button" className="text-xs text-text-secondary hover:text-text-primary" onClick={onRequestBrowserNotifications}>Enable desktop alerts</button>}
    </div>
  );
}
