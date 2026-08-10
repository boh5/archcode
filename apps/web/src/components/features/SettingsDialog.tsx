import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { McpServerStatus, ProviderAdapterCatalog, RuntimeStatus, ServerConfigSnapshot as ServerConfigSnapshotView } from "@archcode/protocol";
import { ApiError } from "../../api/client";
import { getProviderAdapterCatalog, getServerConfig, saveServerConfig, toConfigDraft, type ServerConfigSnapshot } from "../../api/config";
import { useMcpStatusStore } from "../../store/mcp-status-store";
import { DialogContent, DialogDescription, DialogRoot, DialogTitle } from "../ui/Dialog";
import { cloneConfig, hasConfigChanges, missingProfileVariants, toFieldErrors, type SettingsSection } from "./settings-helpers";
import { SettingsProfilesPanel, SettingsGithubPanel, SettingsMcpPanel, SettingsModelsPanel, SettingsNavigation, SettingsSkillsPanel } from "./settings-panels";
import { SettingsMemoryPanel } from "./SettingsMemoryPanel";
import { SettingsSecurityPanel } from "./SettingsSecurityPanel";
import { SettingsRuntimeDataPanel } from "./SettingsRuntimeDataPanel";
import { SettingsUpdatesPanel } from "./SettingsUpdatesPanel";

export { SettingsMcpPanel, SettingsModelsPanel, SettingsNavigation, SettingsSkillsPanel } from "./settings-panels";

type RestartRequiredSection = ServerConfigSnapshotView["restartRequiredSections"][number];

const restartSectionLabels: Record<RestartRequiredSection, string> = {
  "integrations.github": "GitHub",
};

export function SettingsApplyNotice({ modelsAppliedLive, restartRequiredSections, savedWhileRuntimeUnavailable = false }: { modelsAppliedLive: boolean; restartRequiredSections: readonly RestartRequiredSection[]; savedWhileRuntimeUnavailable?: boolean }) {
  if (savedWhileRuntimeUnavailable) return <div role="status" className="shrink-0 border-b border-success/30 bg-success-muted px-5 py-2 text-sm text-success">Configuration saved. Retry Runtime to use the saved configuration.</div>;
  if (!modelsAppliedLive && restartRequiredSections.length === 0) return null;
  return <div role="status" className={`shrink-0 border-b px-5 py-2 text-sm ${restartRequiredSections.length > 0 ? "border-warning/30 bg-warning-muted text-warning" : "border-success/30 bg-success-muted text-success"}`}>
    {modelsAppliedLive && <span>Model and Profile changes applied live.</span>}
    {modelsAppliedLive && restartRequiredSections.length > 0 ? " " : null}
    {restartRequiredSections.length > 0 && <span>Restart required for: {restartRequiredSections.map((section) => restartSectionLabels[section]).join(", ")}.</span>}
  </div>;
}

export function SettingsCloseButton({ onClose }: { onClose: () => void }) {
  return <button type="button" aria-label="Close settings" onClick={onClose} className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-sm text-text-tertiary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"><X size={14} aria-hidden="true" /></button>;
}

export function SettingsBody({ snapshot, adapterCatalog, servers, onReload, runtime = { state: "ready" }, onRefreshRuntime = async () => {}, section: requestedSection = "models", onSectionChange, reloading = false, reloadError, projectSlug }: { snapshot: ServerConfigSnapshot; adapterCatalog: ProviderAdapterCatalog; servers: Record<string, McpServerStatus>; onReload: () => Promise<void>; runtime?: RuntimeStatus; onRefreshRuntime?: () => Promise<void>; section?: SettingsSection; onSectionChange?: (section: SettingsSection) => void; reloading?: boolean; reloadError?: string; projectSlug?: string }) {
  const [section, setSection] = useState<SettingsSection>(requestedSection);
  const [draft, setDraft] = useState(() => cloneConfig(snapshot.config));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [restartRequiredSections, setRestartRequiredSections] = useState(snapshot.restartRequiredSections);
  const [modelsAppliedLive, setModelsAppliedLive] = useState(false);
  const [savedWhileRuntimeUnavailable, setSavedWhileRuntimeUnavailable] = useState(false);
  const [jsonResetVersion, setJsonResetVersion] = useState(0);
  const preserveSaveErrorRevision = useRef<string | undefined>(undefined);

  useEffect(() => {
    setDraft(cloneConfig(snapshot.config));
    setErrors({});
    setJsonErrors({});
    const preserveSaveError = preserveSaveErrorRevision.current === snapshot.revision;
    preserveSaveErrorRevision.current = undefined;
    if (!preserveSaveError) setSaveError(undefined);
    setSavedWhileRuntimeUnavailable(false);
    setRestartRequiredSections(snapshot.restartRequiredSections);
    setJsonResetVersion((current) => current + 1);
  }, [snapshot]);

  useEffect(() => {
    setSection(requestedSection);
  }, [requestedSection]);

  const dirty = useMemo(() => hasConfigChanges(draft, snapshot.config), [draft, snapshot.config]);
  const invalidProfileCount = useMemo(() => missingProfileVariants(draft).length, [draft]);
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
    setSavedWhileRuntimeUnavailable(false);
    setErrors({});
    setSaveError(undefined);
    try {
      const modelSettingsChanged = JSON.stringify(draft.provider) !== JSON.stringify(snapshot.config.provider)
        || JSON.stringify(draft.profiles) !== JSON.stringify(snapshot.config.profiles);
      const response = await saveServerConfig({ expectedRevision: snapshot.revision, config: draft });
      const next = toConfigDraft(response, adapterCatalog);
      useMcpStatusStore.getState().mergeServerSnapshot(response.mcpApply.status.servers);
      setDraft(cloneConfig(next.config));
      setRestartRequiredSections(next.restartRequiredSections);
      if (response.mcpApply.state === "failed") {
        preserveSaveErrorRevision.current = response.revision;
        setSaveError(`Configuration saved, but MCP live apply failed: ${response.mcpApply.error}`);
      }
      await onReload();
      setModelsAppliedLive(runtime.state === "ready" && modelSettingsChanged);
      setSavedWhileRuntimeUnavailable(runtime.state !== "ready");
    } catch (error) {
      preserveSaveErrorRevision.current = undefined;
      const nextErrors = toFieldErrors(error);
      setErrors(nextErrors);
      const firstValidationMessage = Object.values(nextErrors)[0];
      setSaveError(error instanceof ApiError && error.code === "CONFIG_REVISION_CONFLICT"
        ? "This configuration was changed elsewhere. Reload the latest version before saving."
        : firstValidationMessage !== undefined
          ? `Configuration validation failed: ${firstValidationMessage}`
          : error instanceof Error ? error.message : "Unable to save settings");
    } finally {
      setSaving(false);
    }
  };

  const selectSection = (next: SettingsSection) => {
    setSection(next);
    onSectionChange?.(next);
  };

  return <div data-settings-layout className="flex h-full min-h-0 flex-col">
    {section !== "updates" && section !== "runtime-data" && <SettingsApplyNotice modelsAppliedLive={modelsAppliedLive} restartRequiredSections={runtime.state === "ready" ? restartRequiredSections : []} savedWhileRuntimeUnavailable={savedWhileRuntimeUnavailable} />}
    <div data-settings-workspace className="flex min-h-0 flex-1 flex-col sm:flex-row">
      <SettingsSidebar section={section} onSelect={selectSection} invalidProfileCount={invalidProfileCount} />
      {section === "updates"
        ? <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-bg-base px-5 py-5 sm:px-6"><SettingsUpdatesPanel /></main>
        : section === "runtime-data"
          ? <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-bg-base px-5 py-5 sm:px-6"><SettingsRuntimeDataPanel runtime={runtime} onRefreshRuntime={onRefreshRuntime} /></main>
        : <fieldset data-settings-controls disabled={saving || reloading} className="contents">
          <div className="flex min-h-0 flex-1 flex-col"><main className="min-h-0 flex-1 overflow-y-auto bg-bg-base px-5 py-5 sm:px-6">
            <div hidden={section !== "models"}><SettingsModelsPanel config={draft} adapterCatalog={adapterCatalog} onChange={setDraft} errors={fieldErrors} onJsonValidationChange={onJsonValidationChange} jsonResetVersion={jsonResetVersion} /></div>
            <div hidden={section !== "profiles"}><SettingsProfilesPanel config={draft} onChange={setDraft} errors={fieldErrors} onJsonValidationChange={onJsonValidationChange} jsonResetVersion={jsonResetVersion} /></div>
            {section === "security" && <SettingsSecurityPanel onConfigChanged={onReload} />}
            <div hidden={section !== "mcp"}><SettingsMcpPanel active={section === "mcp"} config={draft} savedConfig={snapshot.config} expectedRevision={snapshot.revision} servers={servers} onChange={setDraft} errors={errors} runtimeAvailable={runtime.state === "ready"} /></div>
            {section === "skills" && <SettingsSkillsPanel projectSlug={projectSlug} />}
            <div hidden={section !== "memory"}><SettingsMemoryPanel config={draft} onChange={setDraft} errors={errors} projectSlug={projectSlug} active={section === "memory"} /></div>
            <div hidden={section !== "github"}><SettingsGithubPanel config={draft} onChange={setDraft} errors={errors} /></div>
          </main><footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border-subtle bg-bg-surface px-5 py-3">{saveError || reloadError ? <div role="alert" className="text-[11px] leading-4 text-error">{saveError ?? reloadError}</div> : <span className={`text-[11px] leading-4 ${hasJsonErrors ? "text-error" : dirty ? "text-warning" : "text-text-tertiary"}`}>{hasJsonErrors ? "Fix invalid JSON before saving" : dirty ? "Unsaved changes" : "All changes saved"}</span>}<div className="flex gap-2"><button type="button" onClick={() => { setModelsAppliedLive(false); setSavedWhileRuntimeUnavailable(false); void onReload(); }} className="h-8 rounded-sm bg-bg-active px-4 text-[12px] font-medium text-text-secondary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">{reloading ? "Reloading…" : "Reload"}</button><button type="button" disabled={!dirty || saving || reloading || hasJsonErrors} onClick={() => { void save(); }} className="h-8 rounded-sm bg-brand px-4 text-[12px] font-medium text-bg-overlay transition-colors duration-[var(--motion-hover)] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40">{saving ? "Saving…" : "Save changes"}</button></div></footer></div>
        </fieldset>}
    </div>
  </div>;
}

export function SettingsDialog({ open, section = "models", onClose, projectSlug }: { open: boolean; section?: SettingsSection; onClose: () => void; projectSlug?: string }) {
  return <DialogRoot open={open} onOpenChange={(next) => { if (!next) onClose(); }}><DialogContent size="x-large" className="overflow-hidden p-0"><DialogTitle className="sr-only">Settings</DialogTitle><DialogDescription className="sr-only">Configure ArchCode server settings, Project Skills, Memory, Runtime data, and application updates.</DialogDescription><SettingsCloseButton onClose={onClose} /><SettingsWorkspace active={open} section={section} runtime={{ state: "ready" }} onRefreshRuntime={async () => {}} projectSlug={projectSlug} /></DialogContent></DialogRoot>;
}

export function RuntimeRecoverySettings({ runtime, onRefreshRuntime }: { runtime: RuntimeStatus; onRefreshRuntime: () => Promise<void> }) {
  return <main className="min-h-dvh bg-bg-base p-0 text-text-primary sm:p-4">
    <section aria-label="Runtime recovery settings" className="mx-auto h-dvh min-h-0 w-full overflow-hidden border-border-strong bg-bg-overlay sm:h-[calc(100dvh-32px)] sm:max-w-[1120px] sm:rounded-md sm:border sm:shadow-lg">
      <SettingsWorkspace active section="runtime-data" runtime={runtime} onRefreshRuntime={onRefreshRuntime} />
    </section>
  </main>;
}

function SettingsWorkspace({ active, section, runtime, onRefreshRuntime, projectSlug }: { active: boolean; section: SettingsSection; runtime: RuntimeStatus; onRefreshRuntime: () => Promise<void>; projectSlug?: string }) {
  const servers = useMcpStatusStore((state) => state.servers);
  const [activeSection, setActiveSection] = useState<SettingsSection>(section);
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
    if (active) setActiveSection(section);
  }, [active, section]);
  useEffect(() => {
    if (!active) {
      reloadRequest.current += 1;
      setSnapshot(undefined);
      setAdapterCatalog(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }
    if (
      activeSection !== "updates"
      && activeSection !== "runtime-data"
      && snapshot === undefined
      && adapterCatalog === undefined
      && !loading
      && error === undefined
    ) {
      void reload();
    }
  }, [active, activeSection, snapshot, adapterCatalog, loading, error]);

  const hasConfigData = snapshot !== undefined && adapterCatalog !== undefined;
  return hasConfigData
    ? <SettingsBody snapshot={snapshot} adapterCatalog={adapterCatalog} servers={servers} onReload={reload} runtime={runtime} onRefreshRuntime={onRefreshRuntime} section={activeSection} onSectionChange={setActiveSection} reloading={loading} reloadError={error} projectSlug={projectSlug} />
    : activeSection === "updates" || activeSection === "runtime-data"
      ? <IndependentSettingsWorkspace section={activeSection} onSelect={setActiveSection} runtime={runtime} onRefreshRuntime={onRefreshRuntime} />
      : <SettingsLoadState section={activeSection} onSelect={setActiveSection}>{error
        ? <><p role="alert" className="text-[13px] leading-5 text-error">{error}</p><button type="button" className="mt-3 h-8 rounded-sm bg-bg-active px-4 text-[12px] font-medium text-text-primary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" onClick={() => { void reload(); }}>Retry</button></>
        : "Loading settings…"}</SettingsLoadState>;
}

export function SettingsSidebar({ section, onSelect, invalidProfileCount = 0, recoveryMode = false }: { section: SettingsSection; onSelect: (section: SettingsSection) => void; invalidProfileCount?: number; recoveryMode?: boolean }) {
  return <aside className="flex shrink-0 flex-col border-b border-border-subtle bg-bg-surface sm:w-52 sm:border-b-0 sm:border-r"><div className="border-b border-border-subtle px-4 py-4"><h2 className="text-[16px] font-semibold leading-[22px] text-text-primary">Settings</h2><p className="mt-1 text-[11px] leading-4 text-text-tertiary">Server and application</p></div><SettingsNavigation activeSection={section} onSelect={onSelect} invalidProfileCount={invalidProfileCount} recoveryMode={recoveryMode} /></aside>;
}

function IndependentSettingsWorkspace({ section, onSelect, runtime, onRefreshRuntime }: { section: SettingsSection; onSelect: (section: SettingsSection) => void; runtime: RuntimeStatus; onRefreshRuntime: () => Promise<void> }) {
  return <div className="flex h-full min-h-0 flex-col sm:flex-row"><SettingsSidebar section={section} onSelect={onSelect} /><main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-bg-base px-5 py-5 sm:px-6">{section === "updates" ? <SettingsUpdatesPanel /> : <SettingsRuntimeDataPanel runtime={runtime} onRefreshRuntime={onRefreshRuntime} />}</main></div>;
}

function SettingsLoadState({ section, onSelect, children }: { section: SettingsSection; onSelect: (section: SettingsSection) => void; children: ReactNode }) {
  return <div className="flex h-full min-h-0 flex-col sm:flex-row"><SettingsSidebar section={section} onSelect={onSelect} /><main className="min-h-0 flex-1 overflow-y-auto bg-bg-base p-6 text-sm text-text-tertiary">{children}</main></div>;
}
