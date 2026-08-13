import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, RotateCcw, ShieldAlert, Trash2 } from "lucide-react";
import type {
  BootstrapStatus,
  ConfigRecoveryRemovableItem,
  ConfigRecoveryStatus,
} from "@archcode/protocol";
import {
  getConfigRecoveryStatus,
  removeInvalidConfigItems,
  resetInvalidConfig,
  retryConfigRecovery,
} from "../../api/config-recovery";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../ui/Dialog";

const primaryButton = "inline-flex min-h-8 items-center justify-center gap-2 rounded-sm bg-brand px-3 text-[12px] font-medium text-brand-ink transition-colors duration-[var(--motion-hover)] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:min-h-11";
const dangerButton = "inline-flex min-h-8 items-center justify-center gap-2 rounded-sm bg-error px-3 text-[12px] font-medium text-bg-overlay transition-colors duration-[var(--motion-hover)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:min-h-11";
const secondaryButton = "inline-flex min-h-8 items-center justify-center gap-2 rounded-sm bg-bg-active px-3 text-[12px] font-medium text-text-secondary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:min-h-11";

export function SettingsConfigRecoveryPanel({
  grant,
  onTransition,
}: {
  grant: string;
  onTransition: (status: BootstrapStatus) => void;
}) {
  const [recovery, setRecovery] = useState<ConfigRecoveryStatus>();
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"retry" | "remove" | "reset">();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const loadRecoveryStatus = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setRecovery(await getConfigRecoveryStatus(grant));
    } catch (cause) {
      setError(errorMessage(cause, "Unable to load Config diagnostics."));
    } finally {
      setLoading(false);
    }
  }, [grant]);

  useEffect(() => {
    void loadRecoveryStatus();
  }, [loadRecoveryStatus]);

  useEffect(() => {
    if (recovery === undefined) return;
    const currentIds = new Set((recovery.removableItems ?? []).map((item) => item.id));
    setSelectedIds((selected) => new Set([...selected].filter((id) => currentIds.has(id))));
  }, [recovery]);

  const focusStatus = () => headingRef.current?.focus();
  const focusStatusAfterDialog = () => window.requestAnimationFrame(focusStatus);
  const retry = async () => {
    setAction("retry");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await retryConfigRecovery(grant);
      if (result.status.mode !== "config_error") {
        onTransition(result.status);
        return;
      }
      if (result.recovery !== undefined) setRecovery(result.recovery);
      setNotice("The file was checked again and is still invalid.");
      focusStatus();
    } catch (cause) {
      setError(errorMessage(cause, "Unable to retry configuration."));
      focusStatus();
    } finally {
      setAction(undefined);
    }
  };
  const removeSelected = async () => {
    if (recovery?.revision === undefined || selectedIds.size === 0) return;
    setAction("remove");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await removeInvalidConfigItems(
        grant,
        recovery.revision,
        [...selectedIds],
      );
      setConfirmRemove(false);
      if (result.status.mode !== "config_error") {
        onTransition(result.status);
        return;
      }
      if (result.recovery !== undefined) setRecovery(result.recovery);
      setNotice("The remaining Config is still invalid. Nothing else was removed.");
      focusStatusAfterDialog();
    } catch (cause) {
      setConfirmRemove(false);
      setError(errorMessage(cause, "Unable to remove the selected invalid items. Nothing was changed."));
      focusStatusAfterDialog();
    } finally {
      setAction(undefined);
    }
  };
  const reset = async () => {
    setAction("reset");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await resetInvalidConfig(grant);
      setConfirmReset(false);
      onTransition(result.status);
    } catch (cause) {
      setError(errorMessage(cause, "Unable to reset configuration."));
      setConfirmReset(false);
      focusStatusAfterDialog();
    } finally {
      setAction(undefined);
    }
  };
  const busy = action !== undefined;
  const selectedItems = (recovery?.removableItems ?? []).filter((item) => selectedIds.has(item.id));

  return <section data-settings-section="config-recovery" className="space-y-5 pb-1">
    <header className="border-b border-border-subtle pb-4">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">Server recovery</p>
      <h1 ref={headingRef} tabIndex={-1} className="text-[16px] font-semibold leading-[22px] text-text-primary">Config Recovery</h1>
      <p className="mt-1 text-[13px] leading-5 text-text-tertiary">ArchCode is running, but the global configuration cannot be activated. Remove only confirmed invalid entries, repair the file externally, or use full reset as a last resort.</p>
    </header>

    <div className="flex gap-3 rounded-sm border border-error/30 bg-error-muted px-3 py-3 text-error">
      <ShieldAlert className="mt-0.5 shrink-0" size={17} aria-hidden="true" />
      <div className="min-w-0 text-[12px] leading-5">
        <p className="font-semibold">The current Config does not match this ArchCode release.</p>
        <p className="mt-1">Runtime and Config-dependent Settings remain unavailable until the file is valid.</p>
      </div>
    </div>

    {error && <p role="alert" className="rounded-sm border border-error/30 bg-error-muted px-3 py-2 text-[12px] leading-5 text-error">{error}</p>}
    {notice && <p role="status" aria-live="polite" className="rounded-sm border border-warning/30 bg-warning-muted px-3 py-2 text-[12px] leading-5 text-warning">{notice}</p>}

    {loading
      ? <p className="text-[13px] text-text-tertiary">Loading safe diagnostics…</p>
      : recovery
        ? <>
          <div className="rounded-md border border-border-default bg-bg-surface">
            <div className="border-b border-border-subtle px-4 py-3">
              <p className="text-[11px] font-medium text-text-tertiary">Configuration file</p>
              <code className="mt-1 block break-all font-mono text-[12px] leading-5 text-text-secondary">{recovery.configPath}</code>
            </div>
            <div className="px-4 py-3">
              <p className="text-[11px] font-medium text-text-tertiary">Safe diagnostics</p>
              {recovery.issues.length === 0
                ? <p className="mt-2 text-[12px] leading-5 text-text-secondary">No structured issue was available. Check the server log, repair the file, then retry.</p>
                : <ul className="mt-2 space-y-2" aria-label="Configuration issues">
                  {recovery.issues.map((issue, index) => <li key={`${issue.path}-${index}`} className="rounded-sm border border-border-subtle bg-bg-elevated px-3 py-2">
                    <code className="break-all font-mono text-[11px] text-text-secondary">{issue.path}</code>
                    <p className="mt-1 text-[12px] leading-5 text-text-tertiary">{issue.message}</p>
                  </li>)}
                </ul>}
            </div>
          </div>

          {recovery.revision !== undefined && (recovery.removableItems?.length ?? 0) > 0 && <div className="rounded-md border border-border-default bg-bg-surface px-4 py-4">
            <h2 className="text-[13px] font-semibold text-text-primary">Preserve valid settings</h2>
            <p className="mt-1 text-[12px] leading-5 text-text-tertiary">Select only entries you agree to remove. ArchCode validates the entire remaining Config before writing; if it is still invalid, the file is left unchanged.</p>
            <fieldset className="mt-3 space-y-2">
              <legend className="sr-only">Safely removable invalid Config items</legend>
              {(recovery.removableItems ?? []).map((item) => <label key={item.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-sm border border-border-subtle bg-bg-elevated px-3 py-2.5 hover:border-border-default">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-brand"
                  checked={selectedIds.has(item.id)}
                  disabled={busy}
                  onChange={(event) => setSelectedIds((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(item.id);
                    else next.delete(item.id);
                    return next;
                  })}
                />
                <span className="min-w-0">
                  <span className="block text-[12px] font-medium text-text-primary">{item.label}</span>
                  <code className="mt-0.5 block break-all font-mono text-[11px] text-text-secondary">{item.path}</code>
                  <span className="mt-1 block text-[11px] leading-4 text-text-tertiary">{item.impact}</span>
                </span>
              </label>)}
            </fieldset>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" className={secondaryButton} disabled={busy || selectedIds.size === 0} onClick={() => setConfirmRemove(true)}>
                <Trash2 size={13} aria-hidden="true" />Remove selected invalid items
              </button>
              <span className="text-[11px] text-text-tertiary">{selectedIds.size} selected</span>
            </div>
          </div>}

          <div className="space-y-3">
            <p className="text-[12px] leading-5 text-text-tertiary">After editing the file in your preferred editor, retry without restarting ArchCode.</p>
            <button type="button" className={primaryButton} disabled={busy} onClick={() => { void retry(); }}>
              <RefreshCw size={13} aria-hidden="true" />
              {action === "retry" ? "Checking configuration…" : "Retry configuration"}
            </button>
          </div>

          <details className="border-t border-border-subtle pt-5">
            <summary className="inline-flex min-h-8 cursor-pointer items-center text-[12px] font-medium text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:min-h-11">Reset entire Config — last resort</summary>
            <div className="mt-3 rounded-sm border border-error/30 bg-error-muted px-3 py-3">
              <p className="text-[12px] font-semibold text-error">This removes all global configuration, including valid settings.</p>
              <p className="mt-1 max-w-2xl text-[12px] leading-5 text-text-secondary">Providers, models, profiles, MCP servers, memory, GitHub integration, and login/security configuration will be lost. Project source, Git data, and project Runtime data are not deleted.</p>
              <button type="button" className={`mt-3 ${secondaryButton} text-error`} disabled={busy} onClick={() => setConfirmReset(true)}>
                <RotateCcw size={13} aria-hidden="true" />Reset entire Config
              </button>
            </div>
          </details>
        </>
        : <button type="button" className={secondaryButton} onClick={() => { void loadRecoveryStatus(); }}>
          <RefreshCw size={13} aria-hidden="true" />Retry diagnostics
        </button>}

    <RemoveInvalidConfigItemsDialog
      open={confirmRemove}
      items={selectedItems}
      removing={action === "remove"}
      onCancel={() => setConfirmRemove(false)}
      onConfirm={() => { void removeSelected(); }}
    />
    <ResetInvalidConfigDialog
      open={confirmReset}
      configPath={recovery?.configPath}
      resetting={action === "reset"}
      onCancel={() => setConfirmReset(false)}
      onConfirm={() => { void reset(); }}
    />
  </section>;
}

export function RemoveInvalidConfigItemsDialog({
  open,
  items,
  removing,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  items: readonly ConfigRecoveryRemovableItem[];
  removing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <DialogRoot open={open} onOpenChange={(next) => { if (!next && !removing) onCancel(); }}>
    <DialogContent
      onEscapeKeyDown={(event) => { if (removing) event.preventDefault(); }}
      onPointerDownOutside={(event) => { if (removing) event.preventDefault(); }}
    >
      <div className="p-5">
        <DialogTitle className="text-[16px] font-semibold text-text-primary">Remove selected invalid Config items?</DialogTitle>
        <DialogDescription className="mt-2 text-[13px] leading-5 text-text-secondary">Only the entries listed below will be removed. The operation proceeds only if the entire remaining Config is valid; otherwise nothing is changed.</DialogDescription>
        <div className="mt-3 flex gap-2 rounded-sm border border-warning/30 bg-warning-muted px-3 py-2 text-warning">
          <AlertTriangle className="mt-0.5 shrink-0" size={15} aria-hidden="true" />
          <p className="text-[12px] leading-5">Removing the selected entries is permanent. Valid providers, models, profiles, MCP servers, and security settings remain untouched.</p>
        </div>
        <ul className="mt-3 max-h-56 space-y-2 overflow-y-auto" aria-label="Selected invalid Config items">
          {items.map((item) => <li key={item.id} className="rounded-sm border border-border-subtle bg-bg-elevated px-3 py-2">
            <p className="text-[12px] font-medium text-text-primary">{item.label}</p>
            <p className="mt-1 text-[11px] leading-4 text-text-tertiary">{item.impact}</p>
          </li>)}
        </ul>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className={secondaryButton} disabled={removing} onClick={onCancel}>Cancel</button>
          <button type="button" className={dangerButton} disabled={removing || items.length === 0} onClick={onConfirm}>{removing ? "Validating and removing…" : "Remove selected items"}</button>
        </div>
      </div>
    </DialogContent>
  </DialogRoot>;
}

export function ResetInvalidConfigDialog({
  open,
  configPath,
  resetting,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  configPath?: string;
  resetting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => { if (!open) setConfirmation(""); }, [open]);
  const confirmed = confirmation === "RESET";
  return <DialogRoot open={open} onOpenChange={(next) => { if (!next && !resetting) onCancel(); }}>
      <DialogContent
        onEscapeKeyDown={(event) => { if (resetting) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (resetting) event.preventDefault(); }}
      >
        <div className="p-5">
          <DialogTitle className="text-[16px] font-semibold text-error">Reset the entire Config?</DialogTitle>
          <DialogDescription className="mt-2 text-[13px] leading-5 text-text-secondary">This permanently deletes the whole global Config and opens Setup. All providers, models, profiles, MCP servers, memory, GitHub integration, and login/security settings will be lost.</DialogDescription>
          {configPath && <code className="mt-3 block break-all rounded-sm border border-border-subtle bg-bg-elevated px-3 py-2 font-mono text-[11px] leading-5 text-text-secondary">{configPath}</code>}
          <p className="mt-3 text-[12px] leading-5 text-text-tertiary">Project source, Git data, and project Runtime data are not deleted.</p>
          <label className="mt-4 block text-[12px] font-medium text-text-secondary">
            Type <code className="font-mono text-error">RESET</code> to confirm
            <input
              type="text"
              value={confirmation}
              disabled={resetting}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setConfirmation(event.target.value)}
              className="mt-2 min-h-9 w-full rounded-sm border border-border-default bg-bg-elevated px-3 font-mono text-[12px] text-text-primary outline-none focus:border-brand focus:ring-1 focus:ring-brand [@media(pointer:coarse)]:min-h-11"
            />
          </label>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className={secondaryButton} disabled={resetting} onClick={onCancel}>Cancel</button>
            <button type="button" className={dangerButton} disabled={resetting || !confirmed} onClick={onConfirm}>{resetting ? "Resetting…" : "Delete entire Config and open Setup"}</button>
          </div>
        </div>
      </DialogContent>
    </DialogRoot>;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
