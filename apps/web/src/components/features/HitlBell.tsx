import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, X } from "lucide-react";
import { useAttentionVisibleScopedHitl } from "../../store/hitl-store";
import { HitlAttentionList } from "./HitlAttentionList";

export function HitlBell({
  mobile = false,
  variant = "surface",
}: {
  mobile?: boolean;
  variant?: "surface" | "rail";
}) {
  const entries = useAttentionVisibleScopedHitl();
  const [open, setOpen] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(() => (
    typeof Notification === "undefined" ? "unsupported" : Notification.permission
  ));
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  /** Every dismissal returns keyboard control to the stable Bell trigger. */
  const close = useCallback(() => {
    setOpen(false);
    queueMicrotask(() => buttonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => closeRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    const onDocumentClick = (event: MouseEvent) => {
      if (event.target === null || rootRef.current?.contains(event.target as Node)) return;
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onDocumentClick);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onDocumentClick);
    };
  }, [close, open]);

  const requestBrowserNotifications = useCallback(async () => {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return;
    setNotificationPermission(await Notification.requestPermission());
  }, []);

  return (
    <div ref={rootRef} className={mobile ? "relative" : "relative flex w-full justify-center"}>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Open work that needs you"
        aria-expanded={open}
        aria-controls="hitl-bell-panel"
        className={`relative flex items-center justify-center rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 ${variant === "rail"
          ? "h-[38px] w-[38px] rounded-[9px] text-rail-muted hover:bg-rail-hover hover:text-rail-ink [@media(max-width:720px)]:h-9 [@media(max-width:720px)]:w-9"
          : "h-8 w-8 text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
        }`}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
      >
        <Bell size={16} aria-hidden="true" />
        {entries.length > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-full border-2 border-rail bg-warning px-1 text-[9px] font-bold leading-[11px] text-white dark:text-bg-base" aria-label={`${entries.length} items need you`}>{entries.length > 99 ? "99+" : entries.length}</span>}
      </button>
      {open && <>
        {mobile && <button type="button" aria-label="Close work that needs you" className="fixed inset-0 z-40 bg-black/60" onClick={close} />}
        <section
          id="hitl-bell-panel"
          role="dialog"
          aria-label="Work that needs you"
          className={mobile
            ? "fixed inset-x-2 bottom-2 z-50 max-h-[min(76vh,560px)] overflow-y-auto rounded-[10px] border border-border-strong bg-bg-overlay shadow-lg"
            : "fixed bottom-14 left-[62px] z-50 w-[min(360px,calc(100vw-76px))] overflow-hidden rounded-[10px] border border-border-strong bg-bg-overlay shadow-lg"
          }
        >
          <header className="flex min-h-[58px] items-center justify-between gap-3 border-b border-border-default py-[9px] pl-[13px] pr-2.5">
            <div className="min-w-0 flex-1"><span className="block text-[10.5px] font-bold uppercase leading-[1.5] tracking-[0.08em] text-warning">Needs you</span><h2 className="mt-0.5 truncate text-[13px] font-semibold leading-[1.35] text-text-primary">Work that needs you</h2></div>
            {notificationPermission === "default" ? (
              <button
                type="button"
                className="shrink-0 rounded-sm px-2 py-1 text-[10.5px] font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                onClick={() => void requestBrowserNotifications()}
              >
                Enable desktop alerts
              </button>
            ) : null}
            <button ref={closeRef} type="button" aria-label="Close work that needs you" className="flex h-[34px] w-[30px] shrink-0 items-center justify-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" onClick={close}><X size={14} /></button>
          </header>
          <HitlAttentionList
            entries={entries}
            maxItems={10}
            showProject
            onOpen={close}
            popover
          />
        </section>
      </>}
    </div>
  );
}
