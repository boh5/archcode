import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Database, RefreshCw, Trash2 } from "lucide-react";
import type {
  RuntimeDataInspectionResponse,
  RuntimeDataProjectDeleteResult,
  RuntimeDataProjectInspection,
  RuntimeStatus,
} from "@archcode/protocol";
import { deleteRuntimeData, inspectRuntimeData, retryRuntime } from "../../api/runtime-data";
import { DialogContent, DialogDescription, DialogRoot, DialogTitle } from "../ui/Dialog";

const secondaryButton = "inline-flex min-h-8 items-center justify-center gap-2 rounded-sm bg-bg-active px-3 text-[12px] font-medium text-text-secondary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:min-h-11";
const dangerButton = "inline-flex min-h-8 items-center justify-center gap-2 rounded-sm bg-error px-3 text-[12px] font-semibold text-bg-overlay transition-colors duration-[var(--motion-fast)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:min-h-11";

interface SettingsRuntimeDataPanelProps {
  runtime: RuntimeStatus;
  onRefreshRuntime: () => Promise<void>;
}

export function SettingsRuntimeDataPanel({
  runtime,
  onRefreshRuntime,
}: SettingsRuntimeDataPanelProps) {
  const [displayedRuntime, setDisplayedRuntime] = useState(runtime);
  const [inspection, setInspection] = useState<RuntimeDataInspectionResponse>();
  const [inspectionError, setInspectionError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [deleteResults, setDeleteResults] = useState<RuntimeDataProjectDeleteResult[]>([]);
  const [actionMessage, setActionMessage] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [runtimeRefreshError, setRuntimeRefreshError] = useState<string>();
  const statusHeadingRef = useRef<HTMLHeadingElement>(null);

  const loadInspection = useCallback(async () => {
    setLoading(true);
    setInspectionError(undefined);
    try {
      const next = await inspectRuntimeData();
      setInspection(next);
      const eligible = new Set(next.projects.filter((project) => project.issues.length > 0).map((project) => project.projectSlug));
      setSelected((current) => new Set([...current].filter((slug) => eligible.has(slug))));
    } catch (cause) {
      setInspectionError(cause instanceof Error ? cause.message : "Unable to inspect Runtime data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInspection();
  }, [loadInspection]);

  useEffect(() => {
    setDisplayedRuntime(runtime);
    if (runtime.state === "error" && !runtime.error.recoveryAllowed) {
      setSelected(new Set());
      setConfirmOpen(false);
    }
  }, [runtime]);

  const selectedProjects = useMemo(() => inspection?.projects.filter((project) => selected.has(project.projectSlug)) ?? [], [inspection, selected]);
  const busy = deleting || retrying;
  const runtimeUnavailable = displayedRuntime.state !== "ready";
  const recoveryAllowed = displayedRuntime.state !== "error" || displayedRuntime.error.recoveryAllowed;

  const retry = async () => {
    if (busy || !recoveryAllowed) return;
    setRetrying(true);
    setActionMessage(undefined);
    setActionError(undefined);
    setRuntimeRefreshError(undefined);
    setDeleteResults([]);
    try {
      const nextRuntime = await retryRuntime();
      setDisplayedRuntime(nextRuntime);
      if (nextRuntime.state === "error") {
        setActionError(nextRuntime.error.message);
      } else if (nextRuntime.state === "ready") {
        setActionMessage("Runtime is ready.");
      } else {
        setActionMessage("Runtime activation is in progress.");
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Unable to retry Runtime.");
    }
    try {
      await onRefreshRuntime();
    } catch (cause) {
      setRuntimeRefreshError(cause instanceof Error ? cause.message : "Runtime status could not be refreshed.");
    } finally {
      setRetrying(false);
      queueMicrotask(() => statusHeadingRef.current?.focus());
    }
  };

  const confirmDelete = async () => {
    if (deleting || !recoveryAllowed || selectedProjects.length === 0) return;
    setDeleting(true);
    setActionMessage(undefined);
    setActionError(undefined);
    setRuntimeRefreshError(undefined);
    setDeleteResults([]);
    try {
      const response = await deleteRuntimeData({ projectSlugs: selectedProjects.map((project) => project.projectSlug) });
      setDeleteResults(response.results);
      setDisplayedRuntime(response.runtime);
      if (response.runtime.state === "error" && !response.runtime.error.recoveryAllowed) {
        setSelected(new Set());
      }
      const failures = response.results.filter((result) => result.status === "error");
      if (failures.length > 0) {
        setActionError(`Runtime data could not be deleted for ${failures.length} ${failures.length === 1 ? "project" : "projects"}.`);
      } else {
        setActionMessage(`Runtime data deleted for ${response.results.length} ${response.results.length === 1 ? "project" : "projects"}. Runtime activation was retried automatically.`);
        setSelected(new Set());
      }
      setConfirmOpen(false);
      await loadInspection();
      try {
        await onRefreshRuntime();
      } catch (cause) {
        setRuntimeRefreshError(cause instanceof Error ? cause.message : "Runtime status could not be refreshed.");
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Unable to delete Runtime data.");
      setConfirmOpen(false);
    } finally {
      setDeleting(false);
      window.requestAnimationFrame(() => statusHeadingRef.current?.focus());
    }
  };

  return <section data-settings-section="runtime-data" className="space-y-5 pb-1">
    <header className="border-b border-border-subtle pb-4">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">Server settings</p>
      <h1 ref={statusHeadingRef} tabIndex={-1} className="text-[16px] font-semibold leading-[22px] text-text-primary">Runtime Data</h1>
      <p className="mt-1 max-w-[72ch] text-[13px] leading-5 text-text-tertiary">Inspect project Runtime data and recover the same server process. Detected data issues are not necessarily the cause of the startup error.</p>
    </header>

    <RuntimeStatusCard runtime={displayedRuntime} retrying={retrying} onRetry={() => { void retry(); }} />

    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-[13px] font-semibold text-text-primary">Project Runtime data</h2>
        <p className="mt-1 text-[11px] leading-4 text-text-tertiary">Only projects with detected issues can be selected. Nothing is selected by default.</p>
      </div>
      <button type="button" className={secondaryButton} disabled={loading || busy} onClick={() => { void loadInspection(); }}>
        <RefreshCw size={13} aria-hidden="true" />{loading ? "Inspecting…" : "Inspect again"}
      </button>
    </div>

    {loading && inspection === undefined
      ? <p role="status" className="text-[13px] text-text-tertiary">Inspecting registered projects…</p>
      : inspectionError
        ? <div role="alert" className="rounded-sm border border-error/30 bg-error-muted px-3 py-3 text-[12px] leading-5 text-error">
          <p>{inspectionError}</p>
          <button type="button" className={`mt-2 ${secondaryButton}`} onClick={() => { void loadInspection(); }}>Retry inspection</button>
        </div>
        : inspection && inspection.projects.length === 0
          ? <p className="rounded-sm border border-border-default bg-bg-surface px-4 py-4 text-[13px] leading-5 text-text-secondary">No registered project Runtime data was found.</p>
          : inspection && <ul aria-label="Project Runtime data" className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border-default bg-bg-surface">
            {inspection.projects.map((project) => {
              const hasIssues = project.issues.length > 0;
              const selectable = hasIssues && runtimeUnavailable && recoveryAllowed && !busy;
              return <li key={project.projectSlug} className="min-w-0 px-4 py-4">
                <label className={`flex min-w-0 items-start gap-3 ${selectable ? "cursor-pointer" : "cursor-not-allowed"}`}>
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0 accent-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:h-5 [@media(pointer:coarse)]:w-5"
                    checked={selected.has(project.projectSlug)}
                    disabled={!selectable}
                    onChange={(event) => setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(project.projectSlug);
                      else next.delete(project.projectSlug);
                      return next;
                    })}
                    aria-describedby={`runtime-data-${project.projectSlug}-detail`}
                  />
                  <ProjectInspection project={project} runtimeReady={!runtimeUnavailable} recoveryAllowed={recoveryAllowed} />
                </label>
              </li>;
            })}
          </ul>}

    {(actionMessage || actionError || deleteResults.length > 0) && <div
      role={actionError ? "alert" : "status"}
      aria-live={actionError ? "assertive" : "polite"}
      className={`rounded-sm border px-3 py-3 text-[12px] leading-5 ${actionError ? "border-error/30 bg-error-muted text-error" : "border-success/30 bg-success-muted text-success"}`}
    >
      {actionError ?? actionMessage}
      {deleteResults.some((result) => result.status === "error") && <ul className="mt-2 list-disc space-y-1 pl-5">
        {deleteResults.filter((result) => result.status === "error").map((result) => <li key={result.projectSlug}><span className="font-mono">{result.projectSlug}</span>: {result.error?.message ?? "Delete failed"}</li>)}
      </ul>}
    </div>}

    {runtimeRefreshError && <div role="alert" className="rounded-sm border border-warning/30 bg-warning-muted px-3 py-3 text-[12px] leading-5 text-warning">
      {runtimeRefreshError}
    </div>}

    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
      <p className="text-[11px] leading-4 text-text-tertiary">{selected.size === 0 ? "Select a project with detected issues to continue." : `${selected.size} ${selected.size === 1 ? "project" : "projects"} selected.`}</p>
      <button type="button" className={dangerButton} disabled={!runtimeUnavailable || !recoveryAllowed || busy || selectedProjects.length === 0} onClick={() => setConfirmOpen(true)}>
        <Trash2 size={13} aria-hidden="true" />Delete runtime data
      </button>
    </div>

    <DeleteRuntimeDataDialog
      open={confirmOpen}
      projects={selectedProjects}
      deleting={deleting}
      onCancel={() => setConfirmOpen(false)}
      onConfirm={() => { void confirmDelete(); }}
    />
  </section>;
}

function RuntimeStatusCard({ runtime, retrying, onRetry }: { runtime: RuntimeStatus; retrying: boolean; onRetry: () => void }) {
  const isError = runtime.state === "error";
  const isReady = runtime.state === "ready";
  const recoveryAllowed = runtime.state !== "error" || runtime.error.recoveryAllowed;
  return <section aria-labelledby="runtime-current-status" className={`rounded-sm border px-4 py-4 ${isError ? "border-error/30 bg-error-muted" : isReady ? "border-success/30 bg-success-muted" : "border-warning/30 bg-warning-muted"}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 gap-3">
        <span className={isError ? "text-error" : isReady ? "text-success" : "text-warning"} aria-hidden="true">
          {isError ? <AlertTriangle size={18} /> : isReady ? <CheckCircle2 size={18} /> : <Database size={18} />}
        </span>
        <div className="min-w-0">
          <h2 id="runtime-current-status" className="text-[13px] font-semibold text-text-primary">Runtime {isError ? "could not start" : isReady ? "is ready" : "is activating"}</h2>
          {isError && <p role="alert" className="mt-1 break-words text-[12px] leading-5 text-error">{runtime.error.message}</p>}
          {isError && !recoveryAllowed && <p className="mt-2 text-[12px] font-medium leading-5 text-text-primary">ArchCode must be restarted. Runtime cannot be retried and Runtime data cannot be deleted in this process.</p>}
          {!isError && <p className="mt-1 text-[12px] leading-5 text-text-secondary">{isReady ? "Project work APIs are available." : "ArchCode is starting project work services."}</p>}
        </div>
      </div>
      {!isReady && <button type="button" disabled={!recoveryAllowed || retrying || runtime.state === "activating"} className={secondaryButton} onClick={onRetry}><RefreshCw size={13} aria-hidden="true" />{retrying ? "Retrying…" : "Retry Runtime"}</button>}
    </div>
  </section>;
}

function ProjectInspection({ project, runtimeReady, recoveryAllowed }: { project: RuntimeDataProjectInspection; runtimeReady: boolean; recoveryAllowed: boolean }) {
  const hasIssues = project.issues.length > 0;
  return <span id={`runtime-data-${project.projectSlug}-detail`} className="min-w-0 flex-1">
    <span className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="min-w-0 text-[13px] font-semibold text-text-primary">{project.name}</span>
      <span className={`text-[11px] font-medium ${hasIssues ? "text-error" : "text-success"}`}>{hasIssues ? `${project.issues.length} detected ${project.issues.length === 1 ? "issue" : "issues"}` : "No detected issues"}</span>
    </span>
    <span className="mt-2 block break-all font-mono text-[11px] leading-4 text-text-secondary">{project.workspace}</span>
    <span className="mt-1 block break-all font-mono text-[11px] leading-4 text-text-tertiary">Runtime: {project.runtimePath}</span>
    <span className="mt-1 block text-[11px] leading-4 text-text-tertiary">{project.stats.fileCount.toLocaleString()} {project.stats.fileCount === 1 ? "file" : "files"} · {formatBytes(project.stats.totalBytes)}</span>
    {!hasIssues && <span className="mt-2 block text-[11px] leading-4 text-text-tertiary">This project cannot be selected because no current data issue was detected.</span>}
    {hasIssues && runtimeReady && <span className="mt-2 block text-[11px] leading-4 text-text-tertiary">Deletion is available only while Runtime is unavailable.</span>}
    {hasIssues && !runtimeReady && !recoveryAllowed && <span className="mt-2 block text-[11px] leading-4 text-text-tertiary">Deletion is unavailable until ArchCode is restarted.</span>}
    {hasIssues && <ul className="mt-3 space-y-2" aria-label={`Detected issues for ${project.name}`}>
      {project.issues.map((issue, index) => <li key={`${issue.relativePath}-${index}`} className="rounded-sm border border-error/20 bg-error-muted px-3 py-2">
        <span className="block break-all font-mono text-[11px] leading-4 text-text-primary">{issue.relativePath}</span>
        <span className="mt-1 block text-[11px] leading-4 text-error">{issueReason(issue.reason)}</span>
        {issue.schemaIssues?.map((schemaIssue, schemaIndex) => <span key={schemaIndex} className="mt-1 block break-words text-[11px] leading-4 text-text-secondary">{schemaIssue.path.length > 0 ? `${schemaIssue.path.join(".")}: ` : ""}{schemaIssue.message}</span>)}
      </li>)}
    </ul>}
  </span>;
}

function DeleteRuntimeDataDialog({ open, projects, deleting, onCancel, onConfirm }: { open: boolean; projects: RuntimeDataProjectInspection[]; deleting: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <DialogRoot open={open} onOpenChange={(next) => { if (!next && !deleting) onCancel(); }}>
    <DialogContent size="large" onEscapeKeyDown={(event) => { if (deleting) event.preventDefault(); }} className="max-h-[calc(100dvh-32px)] overflow-y-auto p-0">
      <div className="border-b border-border-subtle px-5 py-4 sm:px-6">
        <DialogTitle className="text-[16px] font-semibold text-text-primary">Permanently delete Runtime data?</DialogTitle>
        <DialogDescription className="mt-2 text-[12px] leading-5 text-text-secondary">This action cannot be undone. The following project Runtime directories will be deleted:</DialogDescription>
      </div>
      <div className="space-y-4 px-5 py-4 sm:px-6">
        <ul className="space-y-3" aria-label="Runtime directories to delete">
          {projects.map((project) => <li key={project.projectSlug} className="rounded-sm border border-border-default bg-bg-surface px-3 py-3">
            <p className="text-[12px] font-semibold text-text-primary">{project.name}</p>
            <p className="mt-1 break-all font-mono text-[11px] leading-4 text-text-secondary">{project.runtimePath}</p>
          </li>)}
        </ul>
        <div className="rounded-sm border border-error/30 bg-error-muted px-3 py-3 text-[12px] leading-5 text-error">
          <p className="font-semibold">You will permanently lose:</p>
          <p>Sessions, Todos, Automations, HITL requests, permissions, attachments, and project memory.</p>
        </div>
        <div className="rounded-sm border border-border-default bg-bg-surface px-3 py-3 text-[12px] leading-5 text-text-secondary">
          <p className="font-semibold text-text-primary">These remain unchanged:</p>
          <p>Source files, <span className="font-mono">.git</span>, <span className="font-mono">.archcode/plans</span>, <span className="font-mono">.archcode/skills</span>, project registration, and <span className="font-mono">~/.archcode/config.json</span>.</p>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle bg-bg-surface px-5 py-3 sm:px-6">
        <button type="button" className={secondaryButton} disabled={deleting} onClick={onCancel}>Cancel</button>
        <button type="button" className={dangerButton} disabled={deleting || projects.length === 0} onClick={onConfirm}>{deleting ? "Deleting…" : "Delete permanently"}</button>
      </div>
    </DialogContent>
  </DialogRoot>;
}

function issueReason(reason: RuntimeDataProjectInspection["issues"][number]["reason"]): string {
  if (reason === "invalid_json") return "Invalid JSON";
  if (reason === "invalid_current_schema") return "Does not match the current ArchCode data format";
  if (reason === "inspection_limit") return "Too large to inspect safely";
  return "Unreadable or unsafe to inspect";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}
