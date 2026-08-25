import { useEffect, useRef, useState } from "react";
import type { ConfigSecretMutation, McpServerStatus, McpToolInventoryItem, ProviderAdapterCatalog, ProviderAdapterDescriptor, ProviderAdapterOptionDescriptor, SkillSourceTier } from "@archcode/protocol";
import { ChevronRight, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { ModelCallOptions, ServerConfig, ServerMcpConfig, ServerModelConfig } from "../../api/config";
import { getMcpInventory, reconnectMcpServer, testMcpDraft } from "../../api/mcp";
import { getCompleteProjectSkillInventoryView, type CompleteProjectSkillInventory } from "../../api/skills";
import { useMcpStatusStore } from "../../store/mcp-status-store";
import { Field, JsonObjectField, NumberField, RenameInput, SecretField, SecretRecordEditor, TextInput } from "./settings-fields";
import { PROFILE_NAMES, BUILT_IN_MCP_NAMES, errorAtOrBelow, missingProfileVariant, type FieldErrors, type SettingsSection, withDraft } from "./settings-helpers";

type JsonValidationChange = (path: string, error?: string) => void;

const secondaryActionClass = "inline-flex h-8 items-center justify-center gap-2 rounded-sm bg-bg-active px-3 text-[12px] font-medium text-text-secondary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:min-h-11";
const subtleActionClass = "inline-flex h-7 items-center justify-center gap-2 rounded-sm px-2 text-[12px] font-medium text-brand transition-colors duration-[var(--motion-fast)] hover:bg-brand-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:min-h-11";
const dangerActionClass = "inline-flex h-7 items-center justify-center gap-2 rounded-sm px-2 text-[12px] font-medium text-error transition-colors duration-[var(--motion-fast)] hover:bg-error-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:min-h-11";
const selectClass = "h-8 w-full rounded-sm border border-border-control bg-bg-base px-3 text-[12px] text-text-primary outline-none transition-colors duration-[var(--motion-fast)] hover:border-text-secondary focus:border-brand focus:ring-2 focus:ring-brand-subtle";
const MODEL_MODALITIES = ["text", "image", "audio", "video"] as const;
type ModelModality = typeof MODEL_MODALITIES[number];

function PanelHeader({ kicker = "Server settings", title, description }: { kicker?: string; title: string; description: string }) {
  return <header className="border-b border-border-subtle pb-[15px]">
    <p className="text-[10.5px] font-bold leading-[1.5] uppercase tracking-[0.09em] text-text-tertiary">{kicker}</p>
    <h1 tabIndex={-1} data-settings-content-heading className="mt-1 text-[17px] font-semibold leading-[1.35] text-text-primary outline-none">{title}</h1>
    <p className="mt-1 max-w-[680px] text-[10.5px] leading-[1.5] text-text-tertiary">{description}</p>
  </header>;
}

function SettingsToggle({ checked, onChange, label, description }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description: string }) {
  return <label className="flex cursor-pointer items-start gap-3 rounded-sm border border-border-subtle bg-bg-elevated px-3 py-3 transition-colors duration-[var(--motion-fast)] hover:border-border-default">
    <input type="checkbox" aria-label={label} checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1 h-4 w-4 accent-brand" />
    <span className="flex flex-col gap-1">
      <span className="text-[13px] font-medium text-text-secondary">{label}</span>
      <span className="text-[11px] leading-4 text-text-tertiary">{description}</span>
    </span>
  </label>;
}

function ModalityField({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: readonly ModelModality[];
  onChange: (value: ModelModality[]) => void;
  error?: string;
}) {
  const selected = new Set(value);
  return <fieldset className={`min-w-0 rounded-sm border bg-bg-base px-3 pb-3 pt-2 ${error ? "border-error/60" : "border-border-control"}`}>
    <legend className="px-1 text-[12px] font-medium leading-4 text-text-secondary">{label}</legend>
    <div className="mt-1 flex flex-wrap gap-2">
      {MODEL_MODALITIES.map((modality) => {
        const checked = selected.has(modality);
        const onlySelection = checked && selected.size === 1;
        return <label key={modality} className={`inline-flex h-7 items-center gap-2 rounded-sm border px-2.5 font-mono text-[11px] transition-colors duration-[var(--motion-fast)] ${checked ? "border-brand/50 bg-brand-subtle text-brand" : "border-border-subtle bg-bg-elevated text-text-tertiary hover:border-border-default hover:text-text-secondary"} ${onlySelection ? "cursor-not-allowed" : "cursor-pointer"}`}>
          <input
            type="checkbox"
            value={modality}
            checked={checked}
            disabled={onlySelection}
            aria-label={`${label}: ${modality}`}
            onChange={(event) => {
              const next = new Set(selected);
              if (event.target.checked) next.add(modality);
              else next.delete(modality);
              onChange(MODEL_MODALITIES.filter((entry) => next.has(entry)));
            }}
            className="h-3.5 w-3.5 accent-brand"
          />
          {modality}
        </label>;
      })}
    </div>
    {error && <p role="alert" className="mt-2 text-[11px] font-normal leading-4 text-error">{error}</p>}
  </fieldset>;
}

function nextGeneratedId(prefix: string, entries: Record<string, unknown>): string {
  let index = Object.keys(entries).length + 1;
  while (entries[`${prefix}-${index}`] !== undefined) index += 1;
  return `${prefix}-${index}`;
}

function hasPreservedSecretRecord(record?: Record<string, ConfigSecretMutation>): boolean {
  return Object.values(record ?? {}).some((secret) => secret.action === "preserve");
}

function hasPreservedProviderSecrets(provider: ServerConfig["provider"][string]): boolean {
  const containsPreservedSecret = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsPreservedSecret);
    if (!value || typeof value !== "object") return false;
    if ((value as { action?: unknown }).action === "preserve") return true;
    return Object.values(value).some(containsPreservedSecret);
  };
  return containsPreservedSecret(provider.options);
}

function optionRecord(options: ServerConfig["provider"][string]["options"]): Record<string, unknown> {
  return options as unknown as Record<string, unknown>;
}

function getOption(options: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, options);
}

function setOption(options: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  const final = segments.pop();
  if (!final) return;
  let current = options;
  const ancestors: Array<[Record<string, unknown>, string]> = [];
  for (const segment of segments) {
    const child = current[segment];
    if (!child || typeof child !== "object" || Array.isArray(child)) {
      if (value === undefined) return;
      current[segment] = {};
    }
    ancestors.push([current, segment]);
    current = current[segment] as Record<string, unknown>;
  }
  if (value !== undefined) {
    current[final] = value;
    return;
  }
  delete current[final];
  for (const [parent, segment] of ancestors.reverse()) {
    const child = parent[segment];
    if (!child || typeof child !== "object" || Array.isArray(child) || Object.keys(child).length > 0) break;
    delete parent[segment];
  }
}

function advancedOptions(options: Record<string, unknown>, adapter?: ProviderAdapterDescriptor): Record<string, unknown> | undefined {
  const advanced = structuredClone(options);
  for (const field of adapter?.fields ?? []) setOption(advanced, field.path, undefined);
  return Object.keys(advanced).length > 0 ? advanced : undefined;
}

function mergeAdvancedOptions(
  options: Record<string, unknown>,
  adapter: ProviderAdapterDescriptor | undefined,
  advanced: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged = structuredClone(advanced ?? {});
  for (const field of adapter?.fields ?? []) {
    const value = getOption(options, field.path);
    if (value !== undefined) setOption(merged, field.path, value);
  }
  return merged;
}

const MCP_STATUS_META: Record<McpServerStatus["state"] | "unreported", { label: string; dotClass: string; badgeClass: string }> = {
  connecting: {
    label: "Connecting",
    dotClass: "bg-warning",
    badgeClass: "border-warning/30 bg-warning-muted text-warning",
  },
  ready: {
    label: "Ready",
    dotClass: "bg-success",
    badgeClass: "border-success/30 bg-success-muted text-success",
  },
  failed: {
    label: "Failed",
    dotClass: "bg-error",
    badgeClass: "border-error/30 bg-error-muted text-error",
  },
  disabled: {
    label: "Disabled",
    dotClass: "bg-text-muted",
    badgeClass: "border-border-default bg-bg-elevated text-text-tertiary",
  },
  unreported: {
    label: "Not reported",
    dotClass: "bg-text-muted",
    badgeClass: "border-border-default bg-bg-elevated text-text-tertiary",
  },
};

export function SettingsNavigation({
  activeSection,
  onSelect,
  invalidProfileCount = 0,
  recoveryMode = false,
  interactionDisabled = false,
}: {
  activeSection: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  invalidProfileCount?: number;
  recoveryMode?: boolean;
  interactionDisabled?: boolean;
}) {
  const entries: Array<[SettingsSection, string]> = [
    ...(recoveryMode ? [["config-recovery", "Config Recovery"]] as Array<[SettingsSection, string]> : []),
    ["models", "Models"],
    ["profiles", "Profiles"],
    ["security", "Security"],
    ["runtime-data", "Runtime Data"],
    ["mcp", "MCP"],
    ["skills", "Skills"],
    ["memory", "Memory"],
    ["github", "GitHub"],
    ["updates", "About & Updates"],
  ];
  return <nav aria-label="Settings sections" className="grid grid-cols-3 gap-[3px] p-2 min-[641px]:flex min-[641px]:flex-col min-[641px]:gap-0.5 min-[641px]:p-2.5">
    <p className="col-span-3 px-[7px] pb-[3px] pt-0.5 text-[9.5px] font-bold uppercase tracking-[0.12em] text-text-tertiary min-[641px]:px-2.5 min-[641px]:pb-1.5 min-[641px]:pt-1.5">Server</p>
    {entries.map(([id, label]) => {
      const disabled = interactionDisabled || recoveryMode && id !== "config-recovery" && id !== "updates";
      const disabledReason = interactionDisabled
        ? "unavailable while the password update is in progress"
        : "unavailable until the global configuration is valid";
      const showsInvalidProfiles = id === "profiles" && invalidProfileCount > 0;
      const attentionMessage = showsInvalidProfiles
        ? `${invalidProfileCount} variant ${invalidProfileCount === 1 ? "reference needs" : "references need"} attention`
        : undefined;
      return <button
        key={id}
        type="button"
        onClick={() => onSelect(id)}
        disabled={disabled}
        aria-current={id === activeSection ? "page" : undefined}
        aria-label={disabled
          ? `${label}, ${disabledReason}`
          : attentionMessage === undefined ? undefined : `${label}, ${attentionMessage}`}
        title={disabled ? disabledReason[0]!.toUpperCase() + disabledReason.slice(1) : attentionMessage}
        data-invalid-count={showsInvalidProfiles ? invalidProfileCount : undefined}
        className={`relative min-h-10 min-w-0 rounded-[5px] px-1.5 text-center text-[11px] font-medium transition-colors duration-[var(--motion-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand disabled:cursor-not-allowed disabled:text-text-muted min-[641px]:min-h-[34px] min-[641px]:px-2.5 min-[641px]:text-left ${id === activeSection ? "bg-brand-subtle text-brand before:absolute before:bottom-0 before:left-2.5 before:right-2.5 before:h-0.5 before:rounded-full before:bg-brand min-[641px]:font-semibold min-[641px]:before:bottom-2 min-[641px]:before:left-0 min-[641px]:before:right-auto min-[641px]:before:top-2 min-[641px]:before:h-auto min-[641px]:before:w-0.5" : disabled ? "" : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"}`}
      >
        <span className="flex items-center justify-center gap-2 min-[641px]:justify-between">
          <span>{label}</span>
          {showsInvalidProfiles && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-error" />}
        </span>
      </button>;
    })}
  </nav>;
}

export function SettingsModelsPanel({ config, adapterCatalog, onChange, errors = {}, onJsonValidationChange, jsonResetVersion = 0 }: { config: ServerConfig; adapterCatalog: ProviderAdapterCatalog; onChange: (config: ServerConfig) => void; errors?: FieldErrors; onJsonValidationChange?: JsonValidationChange; jsonResetVersion?: number }) {
  const addProvider = () => onChange(withDraft(config, (draft) => {
    const adapter = adapterCatalog[0];
    if (!adapter) return;
    const id = nextGeneratedId("provider", draft.provider);
    draft.provider[id] = { npm: adapter.npmPackage, name: "New provider", options: {}, models: {} };
  }));
  return <section data-settings-section="models" className="space-y-[18px] pb-1">
    <PanelHeader kicker="Models" title="Providers and models" description="Configure provider adapters, credentials, model limits, modalities, and variants." />
    {Object.entries(config.provider).map(([providerId, provider]) => {
      const providerIdLocked = hasPreservedProviderSecrets(provider);
      const adapter = adapterCatalog.find((entry) => entry.npmPackage === provider.npm);
      const options = optionRecord(provider.options);
      return <article key={providerId} className="overflow-hidden rounded-md border border-border-default bg-bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle bg-bg-elevated px-4 py-3">
        <div className="min-w-0"><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">Provider</p><h2 className="truncate font-mono text-[13px] font-semibold leading-5 text-text-primary">{providerId}</h2></div>
        <button type="button" aria-label={`Remove provider ${providerId}`} onClick={() => onChange(withDraft(config, (draft) => { delete draft.provider[providerId]; }))} className={dangerActionClass}><Trash2 size={12} aria-hidden="true" />Remove</button>
      </div>
      <div className="space-y-4 p-4">
      <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
        <Field label="Provider ID"><RenameInput value={providerId} readOnly={providerIdLocked} onCommit={(next) => {
          if (next === providerId) return true;
          if (draftHasProvider(config, next)) return false;
          onChange(withDraft(config, (draft) => {
          draft.provider[next] = draft.provider[providerId];
          delete draft.provider[providerId];
          for (const profile of Object.values(draft.profiles)) if (profile.model.startsWith(`${providerId}:`)) profile.model = `${next}:${profile.model.slice(providerId.length + 1)}`;
          }));
          return true;
        }} />{providerIdLocked && <span className="text-[11px] font-normal leading-4 text-text-tertiary">Replace or clear configured secrets before renaming.</span>}</Field>
        <Field label="Display name"><TextInput value={provider.name} onChange={(next) => onChange(withDraft(config, (draft) => { draft.provider[providerId].name = next; }))} /></Field>
        <Field label="Provider package" error={errors[`provider.${providerId}.npm`]}><select className={selectClass} value={provider.npm} onChange={(event) => onChange(withDraft(config, (draft) => { draft.provider[providerId].npm = event.target.value; }))}>{!adapter && <option value={provider.npm}>{provider.npm} (unsupported)</option>}{adapterCatalog.map((entry) => <option key={entry.npmPackage} value={entry.npmPackage}>{entry.displayName} — {entry.npmPackage}</option>)}</select></Field>
      </div>
      {adapter ? <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">{adapter.fields.map((field) => <ProviderOptionField key={field.path} field={field} providerId={providerId} value={getOption(options, field.path)} config={config} onChange={onChange} errors={errors} onJsonValidationChange={onJsonValidationChange} jsonResetVersion={jsonResetVersion} />)}</div> : <p role="alert" className="text-xs text-warning">This package is not available in the server adapter catalog. Choose a supported adapter before saving.</p>}
      <JsonObjectField label="Advanced options JSON" value={advancedOptions(options, adapter)} onChange={(next) => onChange(withDraft(config, (draft) => { draft.provider[providerId].options = mergeAdvancedOptions(optionRecord(draft.provider[providerId].options), adapter, next) as ServerConfig["provider"][string]["options"]; }))} error={errors[`provider.${providerId}.options`]} validationPath={`provider.${providerId}.options`} onValidationChange={onJsonValidationChange} resetVersion={jsonResetVersion} />
      <div className="space-y-3 border-t border-border-subtle pt-4">
        <div className="flex items-center justify-between"><div className="flex items-center gap-2"><h3 className="text-[12px] font-semibold leading-4 text-text-secondary">Models</h3><span className="rounded-sm bg-bg-active px-2 py-1 text-[10px] font-semibold leading-[14px] text-text-tertiary">{Object.keys(provider.models).length}</span></div><button type="button" onClick={() => onChange(withDraft(config, (draft) => {
          const id = nextGeneratedId("model", draft.provider[providerId].models);
          draft.provider[providerId].models[id] = {
            name: "New model",
            limit: { context: 128000, output: 16000 },
            modalities: { input: ["text"], output: ["text"] },
          };
        }))} className={subtleActionClass}><Plus size={12} aria-hidden="true" />Add model</button></div>
        {Object.entries(provider.models).map(([modelId, model]) => <ModelEditor key={modelId} config={config} onChange={onChange} providerId={providerId} modelId={modelId} model={model} errors={errors} onJsonValidationChange={onJsonValidationChange} jsonResetVersion={jsonResetVersion} />)}
      </div>
      </div>
    </article>;
    })}
    <button type="button" disabled={adapterCatalog.length === 0} onClick={addProvider} className="flex w-full items-center justify-center gap-2 rounded-sm border border-dashed border-border-default bg-bg-surface px-3 py-3 text-[12px] font-medium text-text-secondary transition-colors duration-[var(--motion-fast)] hover:border-border-strong hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"><Plus size={14} aria-hidden="true" />Add provider</button>
  </section>;
}

function ProviderOptionField({ field, providerId, value, config, onChange, errors, onJsonValidationChange, jsonResetVersion }: { field: ProviderAdapterOptionDescriptor; providerId: string; value: unknown; config: ServerConfig; onChange: (config: ServerConfig) => void; errors: FieldErrors; onJsonValidationChange?: JsonValidationChange; jsonResetVersion: number }) {
  const path = `provider.${providerId}.options.${field.path}`;
  const update = (next: unknown) => onChange(withDraft(config, (draft) => setOption(optionRecord(draft.provider[providerId].options), field.path, next)));
  const label = field.label;
  if (field.secret && field.kind === "json") return <SecretRecordEditor label={label} value={value as Record<string, ConfigSecretMutation> | undefined} onChange={update} errors={errors} path={path} />;
  if (field.secret) return <SecretField label={label} value={value as ConfigSecretMutation | undefined} onChange={update} error={errors[path]} />;
  if (field.kind === "number") return <Field label={label} error={errors[path]}><NumberField value={typeof value === "number" ? value : undefined} onChange={update} /></Field>;
  if (field.kind === "boolean") return <SettingsToggle checked={value === true} onChange={update} label={label} description={`Provider option: ${field.path}`} />;
  if (field.kind === "json") return <JsonObjectField label={label} value={value as Record<string, unknown> | undefined} onChange={update} error={errorAtOrBelow(errors, path)} validationPath={path} onValidationChange={onJsonValidationChange} resetVersion={jsonResetVersion} />;
  return <Field label={label} error={errors[path]}><TextInput value={typeof value === "string" ? value : ""} onChange={update} /></Field>;
}

function ModelEditor({ config, onChange, providerId, modelId, model, errors, onJsonValidationChange, jsonResetVersion }: { config: ServerConfig; onChange: (config: ServerConfig) => void; providerId: string; modelId: string; model: ServerModelConfig; errors: FieldErrors; onJsonValidationChange?: JsonValidationChange; jsonResetVersion: number }) {
  const update = (apply: (target: ServerModelConfig) => void) => onChange(withDraft(config, (draft) => apply(draft.provider[providerId].models[modelId])));
  const path = `provider.${providerId}.models.${modelId}`;
  return <details className="group rounded-sm border border-border-subtle bg-bg-base open:border-border-default">
    <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-3 transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover [&::-webkit-details-marker]:hidden">
      <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-text-muted transition-transform duration-[var(--motion-fast)] group-open:rotate-90" />
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-text-secondary">{modelId}</span>
      <span className="truncate text-[11px] text-text-tertiary">{model.name}</span>
    </summary>
    <div className="space-y-4 border-t border-border-subtle bg-bg-surface p-4">
      <div className="flex justify-end"><button type="button" aria-label={`Remove model ${modelId}`} onClick={() => onChange(withDraft(config, (draft) => { delete draft.provider[providerId].models[modelId]; }))} className={dangerActionClass}><Trash2 size={12} aria-hidden="true" />Remove model</button></div>
      <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
        <Field label="Model ID"><RenameInput value={modelId} onCommit={(next) => {
          if (next === modelId) return true;
          if (config.provider[providerId].models[next]) return false;
          onChange(withDraft(config, (draft) => {
          draft.provider[providerId].models[next] = draft.provider[providerId].models[modelId];
          delete draft.provider[providerId].models[modelId];
          for (const profile of Object.values(draft.profiles)) if (profile.model === `${providerId}:${modelId}`) profile.model = `${providerId}:${next}`;
          }));
          return true;
        }} /></Field>
        <Field label="Name"><TextInput value={model.name} onChange={(next) => update((draft) => { draft.name = next; })} /></Field>
        <Field label="Context limit"><NumberField value={model.limit.context} onChange={(next) => update((draft) => { draft.limit.context = next ?? 0; })} /></Field>
        <Field label="Output limit"><NumberField value={model.limit.output} onChange={(next) => update((draft) => { draft.limit.output = next ?? 0; })} /></Field>
        <ModalityField
          label="Input modalities"
          value={model.modalities.input}
          onChange={(next) => update((draft) => { draft.modalities.input = next; })}
          error={errorAtOrBelow(errors, `${path}.modalities.input`)}
        />
        <ModalityField
          label="Output modalities"
          value={model.modalities.output}
          onChange={(next) => update((draft) => { draft.modalities.output = next; })}
          error={errorAtOrBelow(errors, `${path}.modalities.output`)}
        />
      </div>
      <JsonObjectField label="Default options JSON" value={model.options as Record<string, unknown> | undefined} onChange={(next) => update((draft) => { draft.options = next as ModelCallOptions | undefined; })} error={errorAtOrBelow(errors, `${path}.options`)} validationPath={`${path}.options`} onValidationChange={onJsonValidationChange} resetVersion={jsonResetVersion} />
      <JsonObjectField label="Variants JSON" value={model.variants as Record<string, unknown> | undefined} onChange={(next) => update((draft) => { draft.variants = next as Record<string, ModelCallOptions> | undefined; })} error={errorAtOrBelow(errors, `${path}.variants`)} validationPath={`${path}.variants`} onValidationChange={onJsonValidationChange} resetVersion={jsonResetVersion} />
    </div>
  </details>;
}

export function SettingsProfilesPanel({ config, onChange, errors, onJsonValidationChange, jsonResetVersion = 0 }: { config: ServerConfig; onChange: (config: ServerConfig) => void; errors: FieldErrors; onJsonValidationChange?: JsonValidationChange; jsonResetVersion?: number }) {
  const models = Object.entries(config.provider).flatMap(([provider, item]) => Object.keys(item.models).map((model) => `${provider}:${model}`));
  return <section className="space-y-5 pb-1"><PanelHeader title="Profiles" description="Principal, deep, and fast model bindings are shared by the fixed Agent catalog." />
    <div className="overflow-hidden rounded-md border border-border-default bg-bg-surface divide-y divide-border-subtle">
    {PROFILE_NAMES.map((profile) => {
      const item = config.profiles[profile];
      const separator = item.model.indexOf(":");
      const provider = separator < 0 ? "" : item.model.slice(0, separator);
      const model = separator < 0 ? "" : item.model.slice(separator + 1);
      const variants = config.provider[provider]?.models[model]?.variants ?? {};
      const optionsPath = `profiles.${profile}.options`;
      const missingVariant = missingProfileVariant(config, profile);
      const variantPath = `profiles.${profile}.variant`;
      const variantError = errors[variantPath] ?? (missingVariant === undefined
        ? undefined
        : `Variant "${missingVariant.variant}" no longer exists. This Profile is using the model default.`);
      return <details key={profile} className="group">
        <summary
          aria-label={missingVariant === undefined
            ? undefined
            : `${profile}, ${item.model}, variant "${missingVariant.variant}" is missing; using model default`}
          className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover [&::-webkit-details-marker]:hidden"
        >
          <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-text-muted transition-transform duration-[var(--motion-fast)] group-open:rotate-90" />
          {missingVariant && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-error" />}
          <span className="min-w-0 flex-1 font-mono text-[12px] font-medium text-text-secondary">{profile}</span>
          <span className="truncate text-[11px] text-text-tertiary">{item.model}{item.variant ? ` · ${item.variant}` : ""}</span>
        </summary>
        <div className="space-y-4 border-t border-border-subtle bg-bg-base p-4">
          <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
            <Field label="Model" error={errors[`profiles.${profile}.model`]}><select className={selectClass} value={item.model} onChange={(event) => onChange(withDraft(config, (draft) => { draft.profiles[profile].model = event.target.value; draft.profiles[profile].variant = undefined; }))}><option value="">Select model</option>{models.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select></Field>
            <Field label="Variant" error={variantError}><select aria-invalid={missingVariant ? true : undefined} className={selectClass} value={item.variant ?? ""} onChange={(event) => onChange(withDraft(config, (draft) => { draft.profiles[profile].variant = event.target.value || undefined; }))}><option value="">Default</option>{missingVariant && <option value={missingVariant.variant} disabled>{missingVariant.variant} (missing)</option>}{Object.keys(variants).map((variant) => <option key={variant} value={variant}>{variant}</option>)}</select></Field>
          </div>
          <JsonObjectField label="Overrides JSON" value={item.options as Record<string, unknown> | undefined} onChange={(next) => onChange(withDraft(config, (draft) => { draft.profiles[profile].options = next as ModelCallOptions | undefined; }))} error={errorAtOrBelow(errors, optionsPath)} validationPath={optionsPath} onValidationChange={onJsonValidationChange} resetVersion={jsonResetVersion} />
        </div>
      </details>;
    })}
    </div>
  </section>;
}

const SKILL_SOURCE_LABELS: Record<SkillSourceTier, string> = {
  "project-archcode": "Project .archcode",
  "project-agents": "Project .agents",
  "user-archcode": "User .archcode",
  "user-agents": "User .agents",
  builtin: "Built-in",
};

export function SettingsSkillsPanel({ projectSlug }: { projectSlug?: string }) {
  const [view, setView] = useState<CompleteProjectSkillInventory>();
  const [state, setState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [error, setError] = useState<string>();
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    if (projectSlug === undefined) {
      setView(undefined);
      setState("idle");
      setError(undefined);
      return;
    }
    let mounted = true;
    setState("loading");
    setError(undefined);
    void getCompleteProjectSkillInventoryView(projectSlug).then((next) => {
      if (!mounted) return;
      setView(next);
      setState("ready");
    }).catch((cause) => {
      if (!mounted) return;
      setView(undefined);
      setState("failed");
      setError(cause instanceof Error ? cause.message : "Unable to load Project Skills");
    });
    return () => { mounted = false; };
  }, [projectSlug, requestVersion]);

  return <section data-settings-skills className="min-w-0 space-y-5 pb-1">
    <PanelHeader title="Project Skills" description="Inspect precedence, package diagnostics, and the bounded Skill directory projected into the model Prompt." />
    {projectSlug === undefined && <p role="status" className="text-[13px] leading-5 text-text-tertiary">Open a project to inspect its Skills.</p>}
    {projectSlug !== undefined && state === "loading" && <p role="status" className="text-[13px] leading-5 text-text-tertiary">Loading Project Skills…</p>}
    {projectSlug !== undefined && state === "failed" && <div>
      <p role="alert" className="break-words text-[12px] leading-5 text-error">Unable to load Project Skills: {error}</p>
      <button type="button" className={`${secondaryActionClass} mt-3`} onClick={() => setRequestVersion((current) => current + 1)}>Retry</button>
    </div>}
    {projectSlug !== undefined && state === "ready" && view !== undefined && <>
      <div className="min-w-0 rounded-md border border-border-default bg-bg-surface p-4">
        <h2 className="text-[13px] font-medium text-text-primary">Prompt directory</h2>
        <p className="mt-1 text-[11px] leading-4 text-text-tertiary">
          {view.promptProjection.includedEntries.length} included · {view.promptProjection.omittedCount} omitted · {view.promptProjection.byteLength} bytes
        </p>
        <details className="mt-3 rounded-sm border border-border-subtle bg-bg-base">
          <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-text-secondary">Preview projected directory</summary>
          <pre className="max-h-56 min-w-0 overflow-auto whitespace-pre-wrap break-words border-t border-border-subtle px-3 py-2 font-mono text-[11px] leading-4 text-text-tertiary">{view.promptProjection.renderedText || "No valid Skills are projected."}</pre>
        </details>
      </div>
      <div className="overflow-hidden rounded-md border border-border-default bg-bg-surface">
        <div className="border-b border-border-subtle px-4 py-3">
          <h2 className="text-[13px] font-medium text-text-primary">Discovered packages</h2>
          <p className="mt-1 text-[11px] text-text-tertiary">{view.items.length} candidate{view.items.length === 1 ? "" : "s"} across all precedence tiers</p>
        </div>
        {view.items.length === 0
          ? <p role="status" className="px-4 py-4 text-[12px] text-text-tertiary">No Skills discovered for this project.</p>
          : <ul className="divide-y divide-border-subtle" aria-label="Project Skill packages">{view.items.map((item, index) => <li key={`${item.source}:${item.name}:${index}`} className="min-w-0 px-4 py-3">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="break-all font-mono text-[12px] font-medium text-text-secondary">{item.name}</h3>
                {item.description && <p className="mt-1 break-words text-[11px] leading-4 text-text-tertiary">{item.description}</p>}
                {item.diagnostic && <p role="alert" className="mt-1 break-words text-[11px] leading-4 text-error">{item.diagnostic.message}</p>}
              </div>
              <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5 text-[10px]">
                <span className="rounded-sm border border-border-subtle bg-bg-elevated px-1.5 py-1 text-text-tertiary">{SKILL_SOURCE_LABELS[item.source]}</span>
                {item.winner && <span className="rounded-sm border border-border-default bg-bg-active px-1.5 py-1 text-text-secondary">Winner</span>}
                {item.shadowed && <span className="rounded-sm border border-border-subtle bg-bg-elevated px-1.5 py-1 text-text-tertiary">Shadowed</span>}
                {item.valid && <span className="rounded-sm border border-success/30 bg-success-muted px-1.5 py-1 text-success">Valid</span>}
                {!item.valid && <span className="rounded-sm border border-error/30 bg-error-muted px-1.5 py-1 text-error">Invalid</span>}
                {item.promptOmitted && <span className="rounded-sm border border-warning/30 bg-warning-muted px-1.5 py-1 text-warning">Prompt omitted</span>}
              </div>
            </div>
          </li>)}</ul>}
      </div>
    </>}
  </section>;
}

export function SettingsMcpPanel({ config, savedConfig = config, expectedRevision = "draft", servers, onChange, errors = {}, runtimeAvailable = true, active = true }: { config: ServerConfig; savedConfig?: ServerConfig; expectedRevision?: string; servers: Record<string, McpServerStatus>; onChange: (config: ServerConfig) => void; errors?: FieldErrors; runtimeAvailable?: boolean; active?: boolean }) {
  const custom = Object.entries(config.mcp?.servers ?? {}).filter(([name]) => !BUILT_IN_MCP_NAMES.includes(name as typeof BUILT_IN_MCP_NAMES[number]));
  const all = [...BUILT_IN_MCP_NAMES.map((name) => [name, undefined] as const), ...custom];
  const [inventory, setInventory] = useState<Record<string, McpToolInventoryItem[]>>({});
  const [testResults, setTestResults] = useState<Record<string, McpToolInventoryItem[]>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [inventoryError, setInventoryError] = useState<string>();
  const [pendingActions, setPendingActions] = useState<Set<string>>(() => new Set());
  const pendingActionsRef = useRef(new Set<string>());
  const actionControllersRef = useRef(new Map<string, AbortController>());
  const mountedRef = useRef(true);
  const updateServer = useMcpStatusStore((state) => state.updateServer);
  const inventoryStatusKey = Object.entries(servers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, status]) => `${name}:${status.state}`)
    .join("|");

  useEffect(() => {
    if (!runtimeAvailable || !active) return;
    const controller = new AbortController();
    setInventoryError(undefined);
    void getMcpInventory({ signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) setInventory(next);
    }).catch((cause) => {
      if (!controller.signal.aborted) {
        setInventoryError(cause instanceof Error ? cause.message : "Unable to load MCP tool inventory");
      }
    });
    return () => controller.abort();
  }, [active, expectedRevision, inventoryStatusKey, runtimeAvailable]);

  useEffect(() => {
    if (active && runtimeAvailable) return;
    for (const controller of actionControllersRef.current.values()) controller.abort();
    actionControllersRef.current.clear();
  }, [active, runtimeAvailable]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const controller of actionControllersRef.current.values()) controller.abort();
      actionControllersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    for (const controller of actionControllersRef.current.values()) controller.abort();
    actionControllersRef.current.clear();
    setTestResults({});
    setActionErrors({});
  }, [config]);

  const runAction = async (key: string, action: () => Promise<void>) => {
    if (pendingActionsRef.current.has(key)) return;
    pendingActionsRef.current.add(key);
    setPendingActions((current) => new Set(current).add(key));
    setActionErrors((current) => { const next = { ...current }; delete next[key]; return next; });
    try { await action(); }
    catch (cause) {
      if (mountedRef.current) {
        setActionErrors((current) => ({ ...current, [key]: cause instanceof Error ? cause.message : "Action failed" }));
      }
    }
    finally {
      pendingActionsRef.current.delete(key);
      if (mountedRef.current) {
        setPendingActions((current) => { const next = new Set(current); next.delete(key); return next; });
      }
    }
  };

  return <section className="space-y-5 pb-1"><PanelHeader title="MCP servers" description="Configuration and discovery status are shown together for built-in and custom servers." />
    {inventoryError && <p role="alert" className="text-[11px] leading-4 text-error">MCP inventory unavailable: {inventoryError}</p>}
    <div className="overflow-hidden rounded-md border border-border-default bg-bg-surface divide-y divide-border-subtle">
    {all.map(([name, server]) => {
      const status = runtimeAvailable ? servers[name] : undefined;
      const builtIn = BUILT_IN_MCP_NAMES.includes(name as typeof BUILT_IN_MCP_NAMES[number]);
      const disabledBuiltins = config.mcp?.disabledBuiltins ?? [];
      const savedDisabledBuiltins = savedConfig.mcp?.disabledBuiltins ?? [];
      const savedServer = savedConfig.mcp?.servers[name];
      const reconnectSaved = builtIn
        ? disabledBuiltins.includes(name as typeof BUILT_IN_MCP_NAMES[number]) === savedDisabledBuiltins.includes(name as typeof BUILT_IN_MCP_NAMES[number])
        : JSON.stringify(server) === JSON.stringify(savedServer);
      const reconnectEnabled = builtIn
        ? !disabledBuiltins.includes(name as typeof BUILT_IN_MCP_NAMES[number])
        : server?.enabled === true;
      const testKey = `test:${name}`;
      const reconnectKey = `reconnect:${name}`;
      const statusMeta = runtimeAvailable ? MCP_STATUS_META[status?.state ?? "unreported"] : {
        label: "Unavailable",
        dotClass: "bg-text-muted",
        badgeClass: "border-border-default bg-bg-elevated text-text-tertiary",
      };
      return <article key={name} className="px-4 py-4 transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover/40">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-all font-mono text-sm">{name}</h2>
            <p className={`mt-1 break-words text-xs ${status?.state === "failed" ? "text-error" : "text-text-tertiary"}`}>{runtimeAvailable ? describeStatus(status) : "Unavailable while Runtime is offline"}</p>
            {status && <time className="mt-1 block text-[10px] text-text-tertiary" dateTime={new Date(statusTimestamp(status)).toISOString()}>Updated {new Date(statusTimestamp(status)).toLocaleString()}</time>}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {builtIn && <span className="rounded-sm bg-bg-active px-2 py-1 text-[11px] font-medium text-text-tertiary">Built-in</span>}
            <span role="status" aria-label={`MCP status: ${statusMeta.label}`} className={`inline-flex items-center gap-2 rounded-sm border px-2 py-1 text-[11px] font-medium ${statusMeta.badgeClass}`}>
              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${statusMeta.dotClass}`} />
              {statusMeta.label}
            </span>
          </div>
        </div>
        {builtIn ? <SettingsToggle checked={!disabledBuiltins.includes(name as typeof BUILT_IN_MCP_NAMES[number])} onChange={(enabled) => onChange(withDraft(config, (draft) => {
          draft.mcp ??= { servers: {} };
          const current = new Set(draft.mcp.disabledBuiltins ?? []);
          if (enabled) current.delete(name as typeof BUILT_IN_MCP_NAMES[number]); else current.add(name as typeof BUILT_IN_MCP_NAMES[number]);
          draft.mcp.disabledBuiltins = BUILT_IN_MCP_NAMES.filter((entry) => current.has(entry));
        }))} label={`Enable ${name}`} description="Expose this built-in server to the live MCP runtime." /> : <McpEditor name={name} server={server!} config={config} onChange={onChange} errors={errors} />}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" disabled={!runtimeAvailable || pendingActions.has(testKey)} title={!runtimeAvailable ? "Runtime is unavailable" : undefined} onClick={() => void runAction(testKey, async () => {
            const controller = new AbortController();
            actionControllersRef.current.set(testKey, controller);
            try {
              const result = await testMcpDraft(name, { expectedRevision, config }, { signal: controller.signal });
              if (actionControllersRef.current.get(testKey) !== controller) return;
              setTestResults((current) => ({ ...current, [name]: result.tools }));
              if (result.warnings.length > 0) setActionErrors((current) => ({ ...current, [testKey]: result.warnings.join(" ") }));
            } catch (cause) {
              if (!controller.signal.aborted) throw cause;
            } finally {
              if (actionControllersRef.current.get(testKey) === controller) {
                actionControllersRef.current.delete(testKey);
              }
            }
          })} className={secondaryActionClass}>{pendingActions.has(testKey) ? <Loader2 size={13} className="animate-activity" aria-hidden="true" /> : null}Test draft</button>
          <button type="button" disabled={!runtimeAvailable || !reconnectSaved || !reconnectEnabled || pendingActions.has(reconnectKey)} title={!reconnectEnabled ? "Enable and save this server before reconnecting" : !reconnectSaved ? "Save this server before reconnecting" : undefined} onClick={() => void runAction(reconnectKey, async () => {
            const controller = new AbortController();
            actionControllersRef.current.set(reconnectKey, controller);
            try {
              const status = (await reconnectMcpServer(name))[name];
              if (controller.signal.aborted) return;
              if (status !== undefined) updateServer(name, status);
              const nextInventory = await getMcpInventory({ signal: controller.signal });
              if (!controller.signal.aborted && mountedRef.current) setInventory(nextInventory);
            } catch (cause) {
              if (!controller.signal.aborted) throw cause;
            } finally {
              if (actionControllersRef.current.get(reconnectKey) === controller) {
                actionControllersRef.current.delete(reconnectKey);
              }
            }
          })} className={secondaryActionClass}>{pendingActions.has(reconnectKey) ? <Loader2 size={13} className="animate-activity" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}Reconnect</button>
          {!reconnectEnabled
            ? <span className="text-[11px] text-text-tertiary">Enable and save before reconnecting.</span>
            : !reconnectSaved && <span className="text-[11px] text-text-tertiary">Save before reconnecting.</span>}
        </div>
        {(actionErrors[testKey] || actionErrors[reconnectKey]) && <p role="alert" className="mt-2 text-[11px] leading-4 text-error">{actionErrors[testKey] ?? actionErrors[reconnectKey]}</p>}
        <McpToolList tools={testResults[name] ?? inventory[name] ?? []} tested={testResults[name] !== undefined} />
      </article>;
    })}
    </div>
    <button type="button" onClick={() => onChange(withDraft(config, (draft) => { draft.mcp ??= { servers: {} }; const name = nextGeneratedId("server", draft.mcp.servers); draft.mcp.servers[name] = { type: "http", enabled: true, url: "https://example.com/mcp" }; }))} className={secondaryActionClass}><Plus size={13} aria-hidden="true" />Add MCP server</button>
  </section>;
}

function McpToolList({ tools, tested }: { tools: McpToolInventoryItem[]; tested: boolean }) {
  if (tools.length === 0) return <p className="mt-3 text-[11px] text-text-tertiary">{tested ? "Draft test discovered no tools." : "No discovered tools."}</p>;
  return <details className="mt-3 min-w-0 rounded-sm border border-border-subtle bg-bg-base"><summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-text-secondary">{tested ? "Draft tools" : "Available tools"} · {tools.length}</summary><ul className="min-w-0 border-t border-border-subtle px-3 py-2" aria-label={`${tested ? "Draft" : "Available"} MCP tools`}>{tools.map((tool) => <li key={tool.registryName} className="min-w-0 py-1"><span className="break-all font-mono text-[11px] text-text-secondary">{tool.name}</span>{tool.description && <span className="ml-2 break-words text-[11px] text-text-tertiary">{tool.description}</span>}</li>)}</ul></details>;
}

function McpEditor({ name, server, config, onChange, errors }: { name: string; server: ServerMcpConfig; config: ServerConfig; onChange: (config: ServerConfig) => void; errors: FieldErrors }) {
  const update = (apply: (target: ServerMcpConfig) => void) => onChange(withDraft(config, (draft) => apply(draft.mcp!.servers[name])));
  const secretRecord = server.type === "http" ? server.headers : server.env;
  const nameLocked = hasPreservedSecretRecord(secretRecord);
  const replaceTransport = (type: "http" | "stdio") => {
    if (nameLocked) return;
    onChange(withDraft(config, (draft) => {
      const current = draft.mcp!.servers[name];
      draft.mcp!.servers[name] = type === "http"
        ? { type, enabled: current.enabled, url: "https://example.com/mcp", connectTimeoutMs: current.connectTimeoutMs, discoveryTimeoutMs: current.discoveryTimeoutMs, callTimeoutMs: current.callTimeoutMs }
        : { type, enabled: current.enabled, command: "", args: [], connectTimeoutMs: current.connectTimeoutMs, discoveryTimeoutMs: current.discoveryTimeoutMs, callTimeoutMs: current.callTimeoutMs };
    }));
  };
  return <div className="mt-4 space-y-4 border-t border-border-subtle pt-4">
    <SettingsToggle checked={server.enabled} onChange={(enabled) => update((draft) => { draft.enabled = enabled; })} label={`Enable ${name}`} description="Connect and expose discovered tools through the live MCP runtime." />
    <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
      <Field label="Name"><RenameInput value={name} readOnly={nameLocked} onCommit={(next) => { if (next === name) return true; if (BUILT_IN_MCP_NAMES.includes(next as typeof BUILT_IN_MCP_NAMES[number]) || config.mcp!.servers[next]) return false; onChange(withDraft(config, (draft) => { draft.mcp!.servers[next] = draft.mcp!.servers[name]; delete draft.mcp!.servers[name]; })); return true; }} />{nameLocked && <span className="text-[11px] font-normal text-text-tertiary">Replace or clear configured secrets before renaming.</span>}</Field>
      <Field label="Transport"><select disabled={nameLocked} title={nameLocked ? "Clear or replace configured secrets before changing transport" : undefined} className={selectClass} value={server.type} onChange={(event) => replaceTransport(event.target.value as "http" | "stdio")}><option value="http">HTTP</option><option value="stdio">STDIO</option></select>{nameLocked && <span className="text-[11px] font-normal text-text-tertiary">Clear or replace configured secrets before changing transport.</span>}</Field>
      {server.type === "http" ? <Field label="HTTP URL" error={errors[`mcp.servers.${name}.url`]}><TextInput value={server.url} onChange={(next) => update((draft) => { if (draft.type === "http") draft.url = next; })} /></Field> : <>
        <Field label="Command" error={errors[`mcp.servers.${name}.command`]}><TextInput value={server.command} onChange={(next) => update((draft) => { if (draft.type === "stdio") draft.command = next; })} /></Field>
        <Field label="Arguments (one per line)"><textarea rows={3} value={server.args?.join("\n") ?? ""} onChange={(event) => update((draft) => { if (draft.type === "stdio") { const args = event.target.value.split("\n").filter((line) => line.trim() !== ""); draft.args = args.length > 0 ? args : undefined; } })} className="min-h-20 resize-y rounded-sm border border-border-control bg-bg-base px-3 py-2 font-mono text-[12px] leading-[18px] text-text-primary outline-none transition-colors duration-[var(--motion-fast)] hover:border-text-secondary focus:border-brand focus:ring-2 focus:ring-brand-subtle" /></Field>
      </>}
      <Field label="Connect timeout (ms)"><NumberField value={server.connectTimeoutMs} onChange={(next) => update((draft) => { draft.connectTimeoutMs = next; })} /></Field>
      <Field label="Discovery timeout (ms)"><NumberField value={server.discoveryTimeoutMs} onChange={(next) => update((draft) => { draft.discoveryTimeoutMs = next; })} /></Field>
      <Field label="Call timeout (ms)"><NumberField value={server.callTimeoutMs} onChange={(next) => update((draft) => { draft.callTimeoutMs = next; })} /></Field>
    </div>
    {server.type === "http" ? <SecretRecordEditor label="Headers" value={server.headers} onChange={(next) => update((draft) => { if (draft.type === "http") draft.headers = next; })} errors={errors} path={`mcp.servers.${name}.headers`} /> : <SecretRecordEditor label="Environment" value={server.env} onChange={(next) => update((draft) => { if (draft.type === "stdio") draft.env = next; })} errors={errors} path={`mcp.servers.${name}.env`} />}
    <button type="button" onClick={() => onChange(withDraft(config, (draft) => { delete draft.mcp!.servers[name]; }))} className={dangerActionClass}><Trash2 size={12} aria-hidden="true" />Delete {name}</button>
  </div>;
}

function draftHasProvider(config: ServerConfig, providerId: string): boolean {
  return config.provider[providerId] !== undefined;
}

export function SettingsGithubPanel({ config, onChange }: { config: ServerConfig; onChange: (config: ServerConfig) => void; errors: FieldErrors }) {
  const github = config.integrations?.github;
  const set = (key: "tokenEnv" | "defaultOwner" | "defaultRepo", value: string) => onChange(withDraft(config, (draft) => { draft.integrations ??= {}; draft.integrations.github ??= {}; draft.integrations.github[key] = value || undefined; }));
  return <section className="space-y-5 pb-1"><PanelHeader title="GitHub" description="Optional GitHub integration settings for repository operations." /><div className="space-y-4 rounded-md border border-border-default bg-bg-surface p-4"><SettingsToggle checked={github ? (github.enabled ?? true) : false} onChange={(enabled) => onChange(withDraft(config, (draft) => { draft.integrations ??= {}; draft.integrations.github = { ...(draft.integrations.github ?? {}), enabled }; }))} label="GitHub integration" description="Expose configured GitHub repository operations to supported agents." /><div className="grid gap-x-4 gap-y-4 border-t border-border-subtle pt-4 sm:grid-cols-2"><Field label="Token environment variable"><TextInput value={github?.tokenEnv} onChange={(next) => set("tokenEnv", next)} /></Field><Field label="Default owner"><TextInput value={github?.defaultOwner} onChange={(next) => set("defaultOwner", next)} /></Field><Field label="Default repository"><TextInput value={github?.defaultRepo} onChange={(next) => set("defaultRepo", next)} /></Field></div></div></section>;
}

function describeStatus(status?: McpServerStatus) {
  if (!status) return "Status not reported yet";
  if (status.state === "ready") {
    const tools = `${status.toolCount} ${status.toolCount === 1 ? "tool" : "tools"} available`;
    return status.warningCount === 0
      ? tools
      : `${tools}; ${status.warningCount} ${status.warningCount === 1 ? "warning" : "warnings"}`;
  }
  if (status.state === "failed") return status.error;
  if (status.state === "connecting") return "Connecting and discovering tools";
  return "Server is disabled in configuration";
}

function statusTimestamp(status: McpServerStatus): number {
  if (status.state === "ready") return status.connectedAt;
  if (status.state === "failed") return status.failedAt;
  if (status.state === "connecting") return status.startedAt;
  return status.updatedAt;
}
