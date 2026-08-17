import type { ReactNode } from "react";
import { Trash2, TriangleAlert } from "lucide-react";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../ui/Dialog";

interface DestructiveActionDialogProps {
  open: boolean;
  title: string;
  description: string;
  subject: string;
  confirmLabel: string;
  pendingLabel: string;
  consequences: readonly string[];
  note?: ReactNode;
  error?: string | null;
  blocked?: boolean;
  blockedMessage?: ReactNode;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function DestructiveActionDialog({
  open,
  title,
  description,
  subject,
  confirmLabel,
  pendingLabel,
  consequences,
  note,
  error,
  blocked = false,
  blockedMessage,
  pending,
  onClose,
  onConfirm,
}: DestructiveActionDialogProps) {
  const closeIfIdle = () => {
    if (!pending) onClose();
  };

  return (
    <DialogRoot open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) closeIfIdle();
    }}>
      <DialogContent
        aria-describedby="destructive-action-description"
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <div className="flex items-start gap-3 border-b border-border-subtle px-5 py-4">
          <span
            aria-hidden="true"
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-error/25 bg-error-muted text-error"
          >
            <Trash2 size={17} />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-[16px] font-semibold leading-6 text-text-primary">
              {title}
            </DialogTitle>
            <DialogDescription
              id="destructive-action-description"
              className="mt-0.5 text-[12px] leading-5 text-text-tertiary"
            >
              {description}
            </DialogDescription>
          </div>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="min-w-0 rounded-md border border-border-default bg-bg-surface px-3.5 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.09em] text-text-muted">
              Selected
            </p>
            <p className="mt-1 truncate text-[13px] font-semibold text-text-primary" title={subject}>
              {subject}
            </p>
          </div>

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
              This will permanently remove
            </p>
            <ul className="mt-2 space-y-1.5">
              {consequences.map((consequence) => (
                <li
                  key={consequence}
                  className="flex gap-2 text-[12px] leading-5 text-text-secondary"
                >
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-error" aria-hidden="true" />
                  <span>{consequence}</span>
                </li>
              ))}
            </ul>
          </div>

          {note ? (
            <div className="flex gap-2.5 rounded-md border border-warning/25 bg-warning-muted px-3 py-2.5 text-[12px] leading-5 text-text-secondary">
              <TriangleAlert className="mt-0.5 shrink-0 text-warning" size={15} aria-hidden="true" />
              <div className="min-w-0">{note}</div>
            </div>
          ) : null}

          {blocked && blockedMessage ? (
            <div className="rounded-md border border-error/30 bg-error-muted px-3 py-2.5 text-[12px] leading-5 text-error">
              {blockedMessage}
            </div>
          ) : null}

          {error ? (
            <div
              aria-live="assertive"
              className="rounded-md border border-error/30 bg-error-muted px-3 py-2.5 text-[12px] leading-5 text-error"
              role="alert"
            >
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button
            type="button"
            onClick={closeIfIdle}
            className="h-8 rounded-sm bg-bg-active px-4 text-[12px] font-medium text-text-primary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40"
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-8 rounded-sm bg-error px-4 text-[12px] font-medium text-bg-overlay transition-colors duration-[var(--motion-fast)] hover:bg-error/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error disabled:cursor-not-allowed disabled:opacity-40"
            disabled={pending || blocked}
          >
            {pending ? pendingLabel : confirmLabel}
          </button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
