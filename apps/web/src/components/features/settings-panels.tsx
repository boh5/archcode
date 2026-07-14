import type { ConfigSecretMutation, McpServerStatus } from "@archcode/protocol";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import type { ModelCallOptions, ServerConfig, ServerMcpConfig, ServerModelConfig } from "../../api/config";
import { Field, JsonObjectField, NumberField, RenameInput, SecretField, SecretRecordEditor, TextInput } from "./settings-fields";
import { AGENT_NAMES, BUILT_IN_MCP_NAMES, defaultMemoryConfig, errorAtOrBelow, OPENAI_COMPATIBLE_PACKAGE, type FieldErrors, type SettingsSection, withDraft } from "./settings-helpers";

type JsonValidationChange = (path: string, error?: string) => void;

const secondaryActionClass = "inline-flex h-8 items-center justify-center gap-1.5 rounded-sm bg-bg-active px-2.5 text-[12px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary";
const subtleActionClass = "inline-flex h-7 items-center justify-center gap-1.5 rounded-sm px-2 text-[11.5px] font-medium text-accent transition-colors duration-150 hover:bg-accent-subtle";
const dangerActionClass = "inline-flex h-7 items-center justify-center gap-1.5 rounded-sm px-2 text-[11.5px] font-medium text-error transition-colors duration-150 hover:bg-error-muted";
const selectClass = "h-9 w-full rounded-sm border border-border-default bg-bg-base px-3 text-[13px] text-text-primary outline-none transition-colors duration-150 hover:border-border-strong focus:border-accent";

function PanelHeader({ title, description }: { title: string; description: string }) {
  return <header className="border-b border-border-subtle pb-4">
    <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">Server settings</p>
    <h1 className="text-[19px] font-semibold tracking-tight text-text-primary">{title}</h1>
    <p className="mt-1 text-[12.5px] text-text-tertiary">{description}</p>
  </header>;
}

function SettingsToggle({ checked, onChange, label, description }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description: string }) {
  return <label className="flex cursor-pointer items-start gap-3 rounded-sm border border-border-subtle bg-bg-elevated px-3 py-3 transition-colors duration-150 hover:border-border-default">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-4 w-4 accent-accent" />
    <span className="flex flex-col gap-0.5">
      <span className="text-[13px] font-medium text-text-secondary">{label}</span>
      <span className="text-[11.5px] text-text-muted">{description}</span>
    </span>
  </label>;
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
  return provider.options.apiKey?.action === "preserve"
    || hasPreservedSecretRecord(provider.options.headers)
    || hasPreservedSecretRecord(provider.options.queryParams);
}

const MCP_STATUS_META: Record<McpServerStatus["state"] | "unreported", { label: string; dotClass: string; badgeClass: string }> = {
  pending: {
    label: "Pending",
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

export function SettingsNavigation({ activeSection, onSelect }: { activeSection: SettingsSection; onSelect: (section: SettingsSection) => void }) {
  const entries: Array<[SettingsSection, string]> = [["models", "Models"], ["agents", "Agents"], ["mcp", "MCP"], ["memory", "Memory"], ["github", "GitHub"]];
  return <nav aria-label="Settings sections" className="grid grid-cols-3 gap-1 px-3 py-3 sm:flex sm:flex-col sm:px-2.5">
    <p className="col-span-3 px-2.5 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">Server</p>
    {entries.map(([id, label]) => <button key={id} type="button" onClick={() => onSelect(id)} aria-current={id === activeSection ? "page" : undefined} className={`relative min-w-0 rounded-sm px-3 py-2 text-left text-[12.5px] font-medium transition-colors duration-150 ${id === activeSection ? "bg-accent-subtle text-accent before:absolute before:bottom-2 before:left-0 before:top-2 before:w-0.5 before:rounded-full before:bg-accent" : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"}`}>{label}</button>)}
  </nav>;
}

export function SettingsModelsPanel({ config, onChange, errors = {}, onJsonValidationChange, jsonResetVersion = 0 }: { config: ServerConfig; onChange: (config: ServerConfig) => void; errors?: FieldErrors; onJsonValidationChange?: JsonValidationChange; jsonResetVersion?: number }) {
  const addProvider = () => onChange(withDraft(config, (draft) => {
    const id = nextGeneratedId("provider", draft.provider);
    draft.provider[id] = { npm: OPENAI_COMPATIBLE_PACKAGE, name: "New provider", options: { baseURL: "https://api.example.com/v1" }, models: {} };
  }));
  return <section data-settings-section="models" className="space-y-5 pb-1">
    <PanelHeader title="Models" description="Providers and their model profiles are configured together." />
    {Object.entries(config.provider).map(([providerId, provider]) => {
      const providerIdLocked = hasPreservedProviderSecrets(provider);
      return <article key={providerId} className="overflow-hidden rounded-md border border-border-default bg-bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle bg-bg-elevated px-4 py-3">
        <div className="min-w-0"><p className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-text-muted">Provider</p><h2 className="truncate font-mono text-[13px] font-semibold text-text-primary">{providerId}</h2></div>
        <button type="button" aria-label={`Remove provider ${providerId}`} onClick={() => onChange(withDraft(config, (draft) => { delete draft.provider[providerId]; }))} className={dangerActionClass}><Trash2 size={12} aria-hidden="true" />Remove</button>
      </div>
      <div className="space-y-4 p-4">
      <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
        <Field label="Provider ID"><RenameInput value={providerId} readOnly={providerIdLocked} onCommit={(next) => {
          if (next === providerId) return true;
          if (draftHasProvider(config, next)) return false;
          onChange(withDraft(config, (draft) => {
          draft.provider[next] = draft.provider[providerId];
          delete draft.provider[providerId];
          for (const agent of Object.values(draft.agents)) if (agent.model.startsWith(`${providerId}:`)) agent.model = `${next}:${agent.model.slice(providerId.length + 1)}`;
          }));
          return true;
        }} />{providerIdLocked && <span className="text-[10.5px] font-normal text-text-muted">Replace or clear configured secrets before renaming.</span>}</Field>
        <Field label="Display name"><TextInput value={provider.name} onChange={(next) => onChange(withDraft(config, (draft) => { draft.provider[providerId].name = next; }))} /></Field>
        <Field label="Base URL" error={errors[`provider.${providerId}.options.baseURL`]}><TextInput value={provider.options.baseURL} onChange={(next) => onChange(withDraft(config, (draft) => { draft.provider[providerId].options.baseURL = next; }))} /></Field>
        <Field label="Provider package"><TextInput value={provider.npm} readOnly onChange={() => {}} /></Field>
        <SecretField label="API key" value={provider.options.apiKey} onChange={(next) => onChange(withDraft(config, (draft) => { draft.provider[providerId].options.apiKey = next; }))} error={errors[`provider.${providerId}.options.apiKey`]} />
        <SecretRecordEditor label="Query params" value={provider.options.queryParams} onChange={(next) => onChange(withDraft(config, (draft) => { draft.provider[providerId].options.queryParams = next; }))} errors={errors} path={`provider.${providerId}.options.queryParams`} />
      </div>
      <SecretRecordEditor label="Headers" value={provider.options.headers} onChange={(next) => onChange(withDraft(config, (draft) => { draft.provider[providerId].options.headers = next; }))} errors={errors} path={`provider.${providerId}.options.headers`} />
      <div className="space-y-2.5 border-t border-border-subtle pt-4">
        <div className="flex items-center justify-between"><div className="flex items-center gap-2"><h3 className="text-[12.5px] font-semibold text-text-secondary">Models</h3><span className="rounded-sm bg-bg-active px-1.5 py-0.5 text-[10px] text-text-muted">{Object.keys(provider.models).length}</span></div><button type="button" onClick={() => onChange(withDraft(config, (draft) => {
          const id = nextGeneratedId("model", draft.provider[providerId].models);
          draft.provider[providerId].models[id] = { name: "New model", limit: { context: 128000, output: 16000 }, modalities: { input: ["text"], output: ["text"] } };
        }))} className={subtleActionClass}><Plus size={12} aria-hidden="true" />Add model</button></div>
        {Object.entries(provider.models).map(([modelId, model]) => <ModelEditor key={modelId} config={config} onChange={onChange} providerId={providerId} modelId={modelId} model={model} errors={errors} onJsonValidationChange={onJsonValidationChange} jsonResetVersion={jsonResetVersion} />)}
      </div>
      </div>
    </article>;
    })}
    <button type="button" onClick={addProvider} className="flex w-full items-center justify-center gap-2 rounded-sm border border-dashed border-border-default bg-bg-surface px-3 py-3 text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:border-border-strong hover:bg-bg-hover hover:text-text-primary"><Plus size={14} aria-hidden="true" />Add provider</button>
  </section>;
}

function ModelEditor({ config, onChange, providerId, modelId, model, errors, onJsonValidationChange, jsonResetVersion }: { config: ServerConfig; onChange: (config: ServerConfig) => void; providerId: string; modelId: string; model: ServerModelConfig; errors: FieldErrors; onJsonValidationChange?: JsonValidationChange; jsonResetVersion: number }) {
  const update = (apply: (target: ServerModelConfig) => void) => onChange(withDraft(config, (draft) => apply(draft.provider[providerId].models[modelId])));
  const path = `provider.${providerId}.models.${modelId}`;
  return <details className="group rounded-sm border border-border-subtle bg-bg-base open:border-border-default">
    <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2.5 transition-colors duration-150 hover:bg-bg-hover [&::-webkit-details-marker]:hidden">
      <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-text-muted transition-transform duration-150 group-open:rotate-90" />
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-text-secondary">{modelId}</span>
      <span className="truncate text-[11.5px] text-text-muted">{model.name}</span>
    </summary>
    <div className="space-y-4 border-t border-border-subtle bg-bg-surface p-4">
      <div className="flex justify-end"><button type="button" aria-label={`Remove model ${modelId}`} onClick={() => onChange(withDraft(config, (draft) => { delete draft.provider[providerId].models[modelId]; }))} className={dangerActionClass}><Trash2 size={12} aria-hidden="true" />Remove model</button></div>
      <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
        <Field label="Model ID"><RenameInput value={modelId} onCommit={(next) => {
          if (next === modelId) return true;
          if (config.provider[providerId].models[next]) return false;
          onChange(withDraft(config, (draft) => {
          draft.provider[providerId].models[next] = draft.provider[providerId].models[modelId];
          delete draft.provider[providerId].models[modelId];
          for (const agent of Object.values(draft.agents)) if (agent.model === `${providerId}:${modelId}`) agent.model = `${providerId}:${next}`;
          }));
          return true;
        }} /></Field>
        <Field label="Name"><TextInput value={model.name} onChange={(next) => update((draft) => { draft.name = next; })} /></Field>
        <Field label="Context limit"><NumberField value={model.limit.context} onChange={(next) => update((draft) => { draft.limit.context = next ?? 0; })} /></Field>
        <Field label="Output limit"><NumberField value={model.limit.output} onChange={(next) => update((draft) => { draft.limit.output = next ?? 0; })} /></Field>
        <Field label="Input modalities"><TextInput value={model.modalities.input.join(", ")} onChange={(next) => update((draft) => { draft.modalities.input = next.split(",").map((entry) => entry.trim()).filter(Boolean) as ServerModelConfig["modalities"]["input"]; })} /></Field>
        <Field label="Output modalities"><TextInput value={model.modalities.output.join(", ")} onChange={(next) => update((draft) => { draft.modalities.output = next.split(",").map((entry) => entry.trim()).filter(Boolean) as ServerModelConfig["modalities"]["output"]; })} /></Field>
      </div>
      <JsonObjectField label="Default options JSON" value={model.options as Record<string, unknown> | undefined} onChange={(next) => update((draft) => { draft.options = next as ModelCallOptions | undefined; })} error={errorAtOrBelow(errors, `${path}.options`)} validationPath={`${path}.options`} onValidationChange={onJsonValidationChange} resetVersion={jsonResetVersion} />
      <JsonObjectField label="Variants JSON" value={model.variants as Record<string, unknown> | undefined} onChange={(next) => update((draft) => { draft.variants = next as Record<string, ModelCallOptions> | undefined; })} error={errorAtOrBelow(errors, `${path}.variants`)} validationPath={`${path}.variants`} onValidationChange={onJsonValidationChange} resetVersion={jsonResetVersion} />
    </div>
  </details>;
}

export function SettingsAgentsPanel({ config, onChange, errors, onJsonValidationChange, jsonResetVersion = 0 }: { config: ServerConfig; onChange: (config: ServerConfig) => void; errors: FieldErrors; onJsonValidationChange?: JsonValidationChange; jsonResetVersion?: number }) {
  const models = Object.entries(config.provider).flatMap(([provider, item]) => Object.keys(item.models).map((model) => `${provider}:${model}`));
  return <section className="space-y-5 pb-1"><PanelHeader title="Agents" description="Each of the seven agents uses an existing configured model and optional variant." />
    <div className="overflow-hidden rounded-md border border-border-default bg-bg-surface divide-y divide-border-subtle">
    {AGENT_NAMES.map((agent) => {
      const item = config.agents[agent];
      const separator = item.model.indexOf(":");
      const provider = separator < 0 ? "" : item.model.slice(0, separator);
      const model = separator < 0 ? "" : item.model.slice(separator + 1);
      const variants = config.provider[provider]?.models[model]?.variants ?? {};
      const optionsPath = `agents.${agent}.options`;
      return <details key={agent} className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 transition-colors duration-150 hover:bg-bg-hover [&::-webkit-details-marker]:hidden">
          <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-text-muted transition-transform duration-150 group-open:rotate-90" />
          <span className="min-w-0 flex-1 font-mono text-[12.5px] font-medium text-text-secondary">{agent}</span>
          <span className="truncate text-[11.5px] text-text-muted">{item.model}{item.variant ? ` · ${item.variant}` : ""}</span>
        </summary>
        <div className="space-y-4 border-t border-border-subtle bg-bg-base p-4">
          <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
            <Field label="Model" error={errors[`agents.${agent}.model`]}><select className={selectClass} value={item.model} onChange={(event) => onChange(withDraft(config, (draft) => { draft.agents[agent].model = event.target.value; draft.agents[agent].variant = undefined; }))}><option value="">Select model</option>{models.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select></Field>
            <Field label="Variant" error={errors[`agents.${agent}.variant`]}><select className={selectClass} value={item.variant ?? ""} onChange={(event) => onChange(withDraft(config, (draft) => { draft.agents[agent].variant = event.target.value || undefined; }))}><option value="">Default</option>{Object.keys(variants).map((variant) => <option key={variant} value={variant}>{variant}</option>)}</select></Field>
          </div>
          <JsonObjectField label="Overrides JSON" value={item.options as Record<string, unknown> | undefined} onChange={(next) => onChange(withDraft(config, (draft) => { draft.agents[agent].options = next as ModelCallOptions | undefined; }))} error={errorAtOrBelow(errors, optionsPath)} validationPath={optionsPath} onValidationChange={onJsonValidationChange} resetVersion={jsonResetVersion} />
        </div>
      </details>;
    })}
    </div>
  </section>;
}

export function SettingsMcpPanel({ config, servers, onChange, errors = {} }: { config: ServerConfig; servers: Record<string, McpServerStatus>; onChange: (config: ServerConfig) => void; errors?: FieldErrors }) {
  const custom = Object.entries(config.mcp?.servers ?? {}).filter(([name]) => !BUILT_IN_MCP_NAMES.includes(name as typeof BUILT_IN_MCP_NAMES[number]));
  const all = [...BUILT_IN_MCP_NAMES.map((name) => [name, undefined] as const), ...custom];
  return <section className="space-y-5 pb-1"><PanelHeader title="MCP servers" description="Configuration and discovery status are shown together for built-in and custom servers." />
    <div className="overflow-hidden rounded-md border border-border-default bg-bg-surface divide-y divide-border-subtle">
    {all.map(([name, server]) => {
      const status = servers[name];
      const builtIn = BUILT_IN_MCP_NAMES.includes(name as typeof BUILT_IN_MCP_NAMES[number]);
      const statusMeta = MCP_STATUS_META[status?.state ?? "unreported"];
      return <article key={name} className="px-4 py-3.5 transition-colors duration-150 hover:bg-bg-hover/40">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate font-mono text-sm">{name}</h2>
            <p className={`mt-1 text-xs ${status?.state === "failed" ? "text-error" : "text-text-tertiary"}`}>{describeStatus(status)}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {builtIn && <span className="rounded-sm bg-bg-active px-1.5 py-0.5 text-[10.5px] font-medium text-text-tertiary">Built-in</span>}
            <span role="status" aria-label={`MCP status: ${statusMeta.label}`} className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[10.5px] font-medium ${statusMeta.badgeClass}`}>
              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${statusMeta.dotClass}`} />
              {statusMeta.label}
            </span>
          </div>
        </div>
        {builtIn ? <p className="mt-3 text-xs text-text-tertiary">Managed by ArchCode. This server cannot be edited, deleted, or overridden.</p> : <McpEditor name={name} server={server!} config={config} onChange={onChange} errors={errors} />}
      </article>;
    })}
    </div>
    <button type="button" onClick={() => onChange(withDraft(config, (draft) => { draft.mcp ??= { servers: {} }; const name = nextGeneratedId("server", draft.mcp.servers); draft.mcp.servers[name] = { url: "https://example.com/mcp" }; }))} className={secondaryActionClass}><Plus size={13} aria-hidden="true" />Add MCP server</button>
  </section>;
}

function McpEditor({ name, server, config, onChange, errors }: { name: string; server: ServerMcpConfig; config: ServerConfig; onChange: (config: ServerConfig) => void; errors: FieldErrors }) {
  const update = (apply: (target: ServerMcpConfig) => void) => onChange(withDraft(config, (draft) => apply(draft.mcp!.servers[name])));
  const nameLocked = hasPreservedSecretRecord(server.headers);
  return <div className="mt-4 space-y-4 border-t border-border-subtle pt-4"><div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2"><Field label="Name"><RenameInput value={name} readOnly={nameLocked} onCommit={(next) => { if (next === name) return true; if (BUILT_IN_MCP_NAMES.includes(next as typeof BUILT_IN_MCP_NAMES[number]) || config.mcp!.servers[next]) return false; onChange(withDraft(config, (draft) => { draft.mcp!.servers[next] = draft.mcp!.servers[name]; delete draft.mcp!.servers[name]; })); return true; }} />{nameLocked && <span className="text-[10.5px] font-normal text-text-muted">Replace or clear configured headers before renaming.</span>}</Field><Field label="HTTP URL" error={errors[`mcp.servers.${name}.url`]}><TextInput value={server.url} onChange={(next) => update((draft) => { draft.url = next; })} /></Field><Field label="Timeout"><NumberField value={server.timeout} onChange={(next) => update((draft) => { draft.timeout = next; })} /></Field></div><SecretRecordEditor label="Headers" value={server.headers} onChange={(next) => update((draft) => { draft.headers = next; })} errors={errors} path={`mcp.servers.${name}.headers`} /><button type="button" onClick={() => onChange(withDraft(config, (draft) => { delete draft.mcp!.servers[name]; }))} className={dangerActionClass}><Trash2 size={12} aria-hidden="true" />Delete {name}</button></div>;
}

function draftHasProvider(config: ServerConfig, providerId: string): boolean {
  return config.provider[providerId] !== undefined;
}

export function SettingsMemoryPanel({ config, onChange, errors }: { config: ServerConfig; onChange: (config: ServerConfig) => void; errors: FieldErrors }) {
  const memory = { ...defaultMemoryConfig(), ...config.memory };
  return <section className="space-y-5 pb-1"><PanelHeader title="Memory" description="Configure extraction thresholds for durable project memory." /><div className="space-y-4 rounded-md border border-border-default bg-bg-surface p-4"><SettingsToggle checked={memory?.enabled ?? true} onChange={(enabled) => onChange(withDraft(config, (draft) => { draft.memory = { ...(draft.memory ?? defaultMemoryConfig()), enabled }; }))} label="Memory extraction" description="Allow completed sessions to contribute durable memory." /><div className="grid gap-x-4 gap-y-3.5 border-t border-border-subtle pt-4 sm:grid-cols-2">{(["minMessages", "minContentLength", "cooldownMs"] as const).map((key) => <Field key={key} label={key} error={errors[`memory.${key}`]}><NumberField value={memory?.[key]} onChange={(next) => onChange(withDraft(config, (draft) => { draft.memory = { ...(draft.memory ?? defaultMemoryConfig()), [key]: next ?? 0 }; }))} /></Field>)}</div></div></section>;
}

export function SettingsGithubPanel({ config, onChange }: { config: ServerConfig; onChange: (config: ServerConfig) => void; errors: FieldErrors }) {
  const github = config.integrations?.github;
  const set = (key: "tokenEnv" | "defaultOwner" | "defaultRepo", value: string) => onChange(withDraft(config, (draft) => { draft.integrations ??= {}; draft.integrations.github ??= {}; draft.integrations.github[key] = value || undefined; }));
  return <section className="space-y-5 pb-1"><PanelHeader title="GitHub" description="Optional GitHub integration settings for repository operations." /><div className="space-y-4 rounded-md border border-border-default bg-bg-surface p-4"><SettingsToggle checked={github ? (github.enabled ?? true) : false} onChange={(enabled) => onChange(withDraft(config, (draft) => { draft.integrations ??= {}; draft.integrations.github = { ...(draft.integrations.github ?? {}), enabled }; }))} label="GitHub integration" description="Expose configured GitHub repository operations to supported agents." /><div className="grid gap-x-4 gap-y-3.5 border-t border-border-subtle pt-4 sm:grid-cols-2"><Field label="Token environment variable"><TextInput value={github?.tokenEnv} onChange={(next) => set("tokenEnv", next)} /></Field><Field label="Default owner"><TextInput value={github?.defaultOwner} onChange={(next) => set("defaultOwner", next)} /></Field><Field label="Default repository"><TextInput value={github?.defaultRepo} onChange={(next) => set("defaultRepo", next)} /></Field></div></div></section>;
}

function describeStatus(status?: McpServerStatus) {
  if (!status) return "Status not reported yet";
  if (status.state === "ready") return `${status.toolCount} ${status.toolCount === 1 ? "tool" : "tools"} available`;
  if (status.state === "failed") return status.error;
  if (status.state === "pending") return "Discovery is still running";
  return "Server is disabled in configuration";
}
