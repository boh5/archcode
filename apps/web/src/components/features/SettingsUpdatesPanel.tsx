import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, RefreshCw, RotateCcw } from "lucide-react";
import type { UpdateStatus } from "@archcode/protocol";
import { useEffect, type ReactNode } from "react";
import {
  checkForUpdate,
  getUpdateStatus,
  installUpdate,
  restartForUpdate,
} from "../../api/update";
import { queryKeys } from "../../api/queries";

const secondaryButtonClass = "inline-flex h-8 items-center justify-center gap-2 rounded-sm bg-bg-active px-3 text-[12px] font-medium text-text-secondary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40";
const primaryButtonClass = "inline-flex h-8 items-center justify-center gap-2 rounded-sm bg-brand px-3 text-[12px] font-medium text-bg-overlay transition-colors duration-[var(--motion-hover)] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40";

export function SettingsUpdatesPanel({ authorizationToken }: { authorizationToken?: string } = {}) {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: queryKeys.update,
    queryFn: () => getUpdateStatus(authorizationToken),
  });
  const applyStatus = (status: UpdateStatus) => {
    queryClient.setQueryData(queryKeys.update, status);
  };
  const check = useMutation({
    mutationFn: () => checkForUpdate(authorizationToken),
    onSuccess: applyStatus,
  });
  const install = useMutation({
    mutationFn: () => installUpdate(authorizationToken),
    onSuccess: applyStatus,
  });
  const restart = useMutation({
    mutationFn: () => restartForUpdate(authorizationToken),
    onSuccess: applyStatus,
  });
  useEffect(() => {
    check.reset();
    install.reset();
    restart.reset();
  }, [statusQuery.dataUpdatedAt]);
  const resetActionErrors = () => {
    check.reset();
    install.reset();
    restart.reset();
  };
  const status = statusQuery.data;
  const busy = status?.phase === "checking"
    || status?.phase === "downloading"
    || status?.phase === "verifying"
    || status?.phase === "installing"
    || check.isPending
    || install.isPending
    || restart.isPending;
  const actionError = check.error ?? install.error ?? restart.error;

  return <section data-settings-section="updates" className="space-y-5 pb-1">
    <header className="border-b border-border-subtle pb-4">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">Application</p>
      <h1 className="text-[16px] font-semibold leading-[22px] text-text-primary">About &amp; Updates</h1>
      <p className="mt-1 text-[13px] leading-5 text-text-tertiary">Install releases signed by the official ArchCode workflow, then restart when the Runtime is idle.</p>
    </header>

    {statusQuery.isLoading
      ? <p className="text-[13px] text-text-tertiary">Loading update status…</p>
      : statusQuery.error
        ? <UpdateAlert message={statusQuery.error.message} />
        : status
          ? <>
            <div className="rounded-md border border-border-default bg-bg-surface">
              <UpdateRow label="Running version" value={`v${status.currentVersion}`} />
              <UpdateRow
                label="Latest verified release"
                value={status.latest
                  ? <a
                    href={status.latest.releaseUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-brand hover:underline"
                  >v{status.latest.version}</a>
                  : "Not checked yet"}
              />
              <UpdateRow
                label="Installation"
                value={status.managed ? "Managed by the official installer" : "Not managed by the official installer"}
              />
              <UpdateRow
                label="Last checked"
                value={status.lastCheckedAt === undefined
                  ? "Never"
                  : new Date(status.lastCheckedAt).toLocaleString()}
                last
              />
            </div>

            <UpdateStateSummary status={status} />
            {status.progress && <UpdateProgressView status={status} />}
            {(status.error || actionError) && <UpdateAlert
              message={actionError?.message ?? status.error?.message ?? "Update failed"}
            />}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={busy}
                onClick={() => {
                  resetActionErrors();
                  check.mutate();
                }}
              >
                <RefreshCw size={13} aria-hidden="true" />
                {status.phase === "checking" || check.isPending ? "Checking…" : "Check now"}
              </button>
              <button
                type="button"
                className={primaryButtonClass}
                disabled={busy || status.restartRequired || !status.managed || !status.updateAvailable}
                onClick={() => {
                  resetActionErrors();
                  install.mutate();
                }}
              >
                <Download size={13} aria-hidden="true" />
                {install.isPending || ["downloading", "verifying", "installing"].includes(status.phase)
                  ? "Installing…"
                  : "Install update"}
              </button>
              {status.restartRequired && <button
                type="button"
                className={primaryButtonClass}
                disabled={busy || !status.restartSupported}
                onClick={() => {
                  resetActionErrors();
                  restart.mutate();
                }}
              >
                <RotateCcw size={13} aria-hidden="true" />
                {restart.isPending ? "Restarting…" : "Restart now"}
              </button>}
            </div>
          </>
          : null}
  </section>;
}

function UpdateRow({
  label,
  value,
  last = false,
}: {
  label: string;
  value: ReactNode;
  last?: boolean;
}) {
  return <div className={`flex flex-wrap items-center justify-between gap-2 px-4 py-3 ${last ? "" : "border-b border-border-subtle"}`}>
    <span className="text-[12px] text-text-tertiary">{label}</span>
    <span className="text-[12px] font-medium text-text-secondary">{value}</span>
  </div>;
}

function UpdateStateSummary({ status }: { status: UpdateStatus }) {
  if (status.error) return null;
  if (!status.managed) {
    return <p className="rounded-sm border border-warning/30 bg-warning-muted px-3 py-2 text-[12px] leading-5 text-warning">Direct installation is disabled because this executable has no matching official install receipt. Reinstall once with the release installer to enable updates.</p>;
  }
  if (status.phase === "checking") {
    return <p className="text-[12px] text-text-tertiary">Checking the latest signed release…</p>;
  }
  if (status.restartRequired) {
    return <p className="rounded-sm border border-brand/30 bg-brand-subtle px-3 py-2 text-[12px] leading-5 text-brand">The verified update is installed. Restart is allowed only when no Session work is running.</p>;
  }
  if (status.updateAvailable && status.latest) {
    return <p className="rounded-sm border border-brand/30 bg-brand-subtle px-3 py-2 text-[12px] leading-5 text-brand">ArchCode v{status.latest.version} is ready to install.</p>;
  }
  if (status.latest === undefined || status.lastCheckedAt === undefined) {
    return <p className="text-[12px] text-text-tertiary">No verified update check has completed yet.</p>;
  }
  return <p className="flex items-center gap-2 text-[12px] text-success"><CheckCircle2 size={14} aria-hidden="true" />This installation is current.</p>;
}

function UpdateProgressView({ status }: { status: UpdateStatus }) {
  const progress = status.progress!;
  const percent = progress.downloadedBytes !== undefined
    && progress.totalBytes !== undefined
    && progress.totalBytes > 0
    ? Math.min(100, Math.round(progress.downloadedBytes / progress.totalBytes * 100))
    : undefined;
  return <div role="status" className="space-y-2">
    <div className="flex items-center justify-between text-[11px] text-text-tertiary">
      <span>{progress.phase === "downloading" ? "Downloading" : progress.phase === "verifying" ? "Verifying signature and archive" : "Installing atomically"}</span>
      {percent !== undefined && <span>{percent}%</span>}
    </div>
    <div className="h-1.5 overflow-hidden rounded-full bg-bg-active">
      <div
        className={`h-full rounded-full bg-brand transition-[width] ${percent === undefined ? "w-1/3" : ""}`}
        style={percent === undefined ? undefined : { width: `${percent}%` }}
      />
    </div>
  </div>;
}

function UpdateAlert({ message }: { message: string }) {
  return <p role="alert" className="rounded-sm border border-error/30 bg-error-muted px-3 py-2 text-[12px] leading-5 text-error">{message}</p>;
}
