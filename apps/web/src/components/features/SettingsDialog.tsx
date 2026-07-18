import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { McpServerStatus, ProviderAdapterCatalog, ServerConfigSnapshot as ServerConfigSnapshotView } from "@archcode/protocol";
import { ApiError } from "../../api/client";
import { getProviderAdapterCatalog, getServerConfig, saveServerConfig, toConfigDraft, type ServerConfigSnapshot } from "../../api/config";
import { useMcpStatusStore } from "../../store/mcp-status-store";
import { DialogContent, DialogDescription, DialogRoot, DialogTitle } from "../ui/Dialog";
import { cloneConfig, hasConfigChanges, toFieldErrors, type SettingsSection } from "./settings-helpers";
import { SettingsAgentsPanel, SettingsGithubPanel, SettingsMcpPanel, SettingsMemoryPanel, SettingsModelsPanel, SettingsNavigation } from "./settings-panels";

export { SettingsMcpPanel, SettingsModelsPanel, SettingsNavigation } from "./settings-panels";

type RestartRequiredSection = ServerConfigSnapshotView["restartRequiredSections"][number];

const restartSectionLabels: Record<RestartRequiredSection, string> = {
  mcp: "MCP",
  memory: "Memory",
  "integrations.github": "GitHub",
};

export function SettingsApplyNotice({ modelsAppliedLive, restartRequiredSections }: { modelsAppliedLive: boolean; restartRequiredSections: readonly RestartRequiredSection[] }) {
  if (!modelsAppliedLive && restartRequiredSections.length === 0) return null;
  return <div role="status" className={`border-b px-5 py-2 text-sm ${restartRequiredSections.length > 0 ? "border-warning/30 bg-warning-muted text-warning" : "border-success/30 bg-success-muted text-success"}`}>
    {modelsAppliedLive && <span>Model and Agent changes applied live.</span>}
    {modelsAppliedLive && restartRequiredSections.length > 0 ? " " : null}
    {restartRequiredSections.length > 0 && <span>Restart required for: {restartRequiredSections.map((section) => restartSectionLabels[section]).join(", ")}.</span>}
  </div>;
}

export function SettingsCloseButton({ onClose }: { onClose: () => void }) {
  return <button type="button" aria-label="Close settings" onClick={onClose} className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-sm text-[12px] text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent">✕</button>;
}

export function SettingsBody({ snapshot, adapterCatalog, servers, onReload, section: requestedSection = "models", reloading = false, reloadError }: { snapshot: ServerConfigSnapshot; adapterCatalog: ProviderAdapterCatalog; servers: Record<string, McpServerStatus>; onReload: () => Promise<void>; section?: SettingsSection; reloading?: boolean; reloadError?: string }) {
  const [section, setSection] = useState<SettingsSection>(requestedSection);
  const [draft, setDraft] = useState(() => cloneConfig(snapshot.config));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [restartRequiredSections, setRestartRequiredSections] = useState(snapshot.restartRequiredSections);
  const [modelsAppliedLive, setModelsAppliedLive] = useState(false);
  const [jsonResetVersion, setJsonResetVersion] = useState(0);

  useEffect(() => {
    setDraft(cloneConfig(snapshot.config));
    setErrors({});
    setJsonErrors({});
    setSaveError(undefined);
    setRestartRequiredSections(snapshot.restartRequiredSections);
    setJsonResetVersion((current) => current + 1);
  }, [snapshot]);

  useEffect(() => {
    setSection(requestedSection);
  }, [requestedSection]);

  const dirty = useMemo(() => hasConfigChanges(draft, snapshot.config), [draft, snapshot.config]);
  const onJsonValidationChange = useCallback((path: string, error?: string) => {
    setJsonErrors((current) => {
      if (error === undefined) {
        if (!(path in current)) return current;
        const next = { ...current };
        delete next[path];
        return next;
      }
      return current[path] === error ? current : { ...current, [path]: error };
    });
  }, []);
  const hasJsonErrors = Object.keys(jsonErrors).length > 0;
  const fieldErrors = { ...errors, ...jsonErrors };
  const save = async () => {
    if (hasJsonErrors) return;
    setSaving(true);
    setModelsAppliedLive(false);
    setErrors({});
    setSaveError(undefined);
    try {
      const modelSettingsChanged = JSON.stringify(draft.provider) !== JSON.stringify(snapshot.config.provider)
        || JSON.stringify(draft.agents) !== JSON.stringify(snapshot.config.agents);
      const next = toConfigDraft(
        await saveServerConfig({ expectedRevision: snapshot.revision, config: draft }),
        adapterCatalog,
      );
      setDraft(cloneConfig(next.config));
      setRestartRequiredSections(next.restartRequiredSections);
      await onReload();
      setModelsAppliedLive(modelSettingsChanged);
    } catch (error) {
      setErrors(toFieldErrors(error));
      setSaveError(error instanceof ApiError && error.code === "CONFIG_REVISION_CONFLICT"
        ? "This configuration was changed elsewhere. Reload the latest version before saving."
        : error instanceof Error ? error.message : "Unable to save settings");
    } finally {
      setSaving(false);
    }
  };

  return <><SettingsApplyNotice modelsAppliedLive={modelsAppliedLive} restartRequiredSections={restartRequiredSections} /><div className="flex h-full min-h-0 flex-col sm:flex-row">
    <fieldset data-settings-controls disabled={saving || reloading} className="contents">
    <aside className="flex shrink-0 flex-col border-b border-border-subtle bg-bg-surface sm:w-52 sm:border-b-0 sm:border-r"><div className="border-b border-border-subtle px-4 py-4"><h2 className="text-[15px] font-semibold tracking-tight text-text-primary">Settings</h2><p className="mt-0.5 text-[11.5px] text-text-muted">Server configuration</p></div><SettingsNavigation activeSection={section} onSelect={setSection} /></aside>
    <div className="flex min-h-0 flex-1 flex-col"><main className="min-h-0 flex-1 overflow-y-auto bg-bg-base px-5 py-5 sm:px-6">
      <div hidden={section !== "models"}><SettingsModelsPanel config={draft} adapterCatalog={adapterCatalog} onChange={setDraft} errors={fieldErrors} onJsonValidationChange={onJsonValidationChange} jsonResetVersion={jsonResetVersion} /></div>
      <div hidden={section !== "agents"}><SettingsAgentsPanel config={draft} onChange={setDraft} errors={fieldErrors} onJsonValidationChange={onJsonValidationChange} jsonResetVersion={jsonResetVersion} /></div>
      <div hidden={section !== "mcp"}><SettingsMcpPanel config={draft} servers={servers} onChange={setDraft} errors={errors} /></div>
      <div hidden={section !== "memory"}><SettingsMemoryPanel config={draft} onChange={setDraft} errors={errors} /></div>
      <div hidden={section !== "github"}><SettingsGithubPanel config={draft} onChange={setDraft} errors={errors} /></div>
    </main><footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border-subtle bg-bg-surface px-5 py-3">{saveError || reloadError ? <div role="alert" className="text-xs text-error">{saveError ?? reloadError}</div> : <span className={`text-[11.5px] ${hasJsonErrors ? "text-error" : dirty ? "text-warning" : "text-text-muted"}`}>{hasJsonErrors ? "Fix invalid JSON before saving" : dirty ? "Unsaved changes" : "All changes saved"}</span>}<div className="flex gap-2"><button type="button" onClick={() => { setModelsAppliedLive(false); void onReload(); }} className="rounded-sm bg-bg-active px-4 py-2 text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary">{reloading ? "Reloading…" : "Reload"}</button><button type="button" disabled={!dirty || saving || reloading || hasJsonErrors} onClick={() => { void save(); }} className="rounded-sm bg-accent px-4 py-2 text-[12.5px] font-medium text-bg-base transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40">{saving ? "Saving…" : "Save changes"}</button></div></footer></div>
    </fieldset>
  </div></>;
}

export function SettingsDialog({ open, section = "models", onClose }: { open: boolean; section?: SettingsSection; onClose: () => void }) {
  const servers = useMcpStatusStore((state) => state.servers);
  const [snapshot, setSnapshot] = useState<ServerConfigSnapshot>();
  const [adapterCatalog, setAdapterCatalog] = useState<ProviderAdapterCatalog>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const reloadRequest = useRef(0);
  const reload = async () => {
    const request = ++reloadRequest.current;
    setLoading(true);
    setError(undefined);
    try {
      const [view, adapters] = await Promise.all([getServerConfig(), getProviderAdapterCatalog()]);
      const next = toConfigDraft(view, adapters);
      if (request === reloadRequest.current) {
        setSnapshot(next);
        setAdapterCatalog(adapters);
      }
    } catch (cause) {
      if (request === reloadRequest.current) setError(cause instanceof Error ? cause.message : "Unable to load server settings");
    } finally {
      if (request === reloadRequest.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (open) void reload();
    else {
      reloadRequest.current += 1;
      setSnapshot(undefined);
      setAdapterCatalog(undefined);
      setError(undefined);
      setLoading(false);
    }
  }, [open]);
  return <DialogRoot open={open} onOpenChange={(next) => { if (!next) onClose(); }}><DialogContent size="x-large" className="overflow-hidden p-0"><DialogTitle className="sr-only">Settings</DialogTitle><DialogDescription className="sr-only">Configure ArchCode server settings.</DialogDescription><SettingsCloseButton onClose={onClose} />{loading && (!snapshot || !adapterCatalog) ? <div className="p-6 text-sm">Loading settings…</div> : error && (!snapshot || !adapterCatalog) ? <div className="p-6"><p role="alert" className="text-sm text-error">{error}</p><button type="button" onClick={() => { void reload(); }}>Retry</button></div> : snapshot && adapterCatalog ? <SettingsBody snapshot={snapshot} adapterCatalog={adapterCatalog} servers={servers} onReload={reload} section={section} reloading={loading} reloadError={error} /> : null}</DialogContent></DialogRoot>;
}
