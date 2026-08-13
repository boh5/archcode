import { useEffect, useMemo, useState } from "react";
import { BookOpen, Check, Plus, RefreshCw, Save, Trash2, TriangleAlert } from "lucide-react";
import type { ServerConfig } from "../../api/config";
import {
  deleteMemoryPreferences,
  deleteMemoryTopic,
  getMemorySnapshot,
  getMemoryTopic,
  putMemoryPreferences,
  putMemoryTopic,
  type MemoryCapacity,
  type MemoryPreferencesItem,
  type MemorySnapshot,
  type MemoryTopicItem,
  type MemoryTopicSummary,
} from "../../api/memory";
import { ApiError } from "../../api/client";
import { DestructiveActionDialog } from "./DestructiveActionDialog";
import { Field, TextInput } from "./settings-fields";
import { defaultMemoryConfig, type FieldErrors, withDraft } from "./settings-helpers";

type TopicType = "user" | "feedback" | "project" | "reference";

const buttonClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-sm bg-brand px-3 text-[12px] font-medium text-brand-ink transition-colors duration-[var(--motion-hover)] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0 sm:h-8";
const secondaryButtonClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-sm bg-bg-active px-3 text-[12px] font-medium text-text-secondary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0 sm:h-8";
const dangerButtonClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-sm px-2.5 text-[12px] font-medium text-error transition-colors duration-[var(--motion-hover)] hover:bg-error-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0 sm:h-7";
const selectClass = "h-9 w-full rounded-sm border border-border-control bg-bg-base px-3 text-[12px] text-text-primary outline-none transition-colors duration-[var(--motion-hover)] hover:border-text-secondary focus:border-brand focus:ring-2 focus:ring-brand-subtle sm:h-8";

interface SettingsMemoryPanelProps {
  config: ServerConfig;
  onChange: (config: ServerConfig) => void;
  errors?: FieldErrors;
  projectSlug?: string;
  active?: boolean;
}

interface TopicDraft {
  name: string;
  title: string;
  type: TopicType;
  description: string;
  content: string;
  revision: string | null;
  isNew: boolean;
}

export function SettingsMemoryPanel({ config, onChange, errors = {}, projectSlug, active = true }: SettingsMemoryPanelProps) {
  const memory = { ...defaultMemoryConfig(), ...(config.memory as unknown as Partial<ReturnType<typeof defaultMemoryConfig>> | undefined) };
  const [snapshot, setSnapshot] = useState<MemorySnapshot>();
  const [preferences, setPreferences] = useState<MemoryPreferencesItem | null>(null);
  const [preferencesDraft, setPreferencesDraft] = useState("");
  const [topicDraft, setTopicDraft] = useState<TopicDraft>();
  const [loading, setLoading] = useState(false);
  const [loadingTopic, setLoadingTopic] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [savingTopic, setSavingTopic] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<"preferences" | "topic" | null>(null);
  const [selectedTopicName, setSelectedTopicName] = useState<string>();

  const loadSnapshot = async () => {
    if (!projectSlug) return;
    setLoading(true);
    setError(undefined);
    try {
      const next = await getMemorySnapshot(projectSlug);
      setSnapshot(next);
      const nextPreferences = next.preferences;
      setPreferences(nextPreferences);
      setPreferencesDraft(nextPreferences?.content ?? "");
      if (selectedTopicName && !next.topics.some((topic) => topic.name === selectedTopicName)) {
        setSelectedTopicName(undefined);
        setTopicDraft(undefined);
      }
    } catch (cause) {
      setError(toMemoryError(cause, "Unable to load Memory"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!active || !projectSlug) {
      if (!projectSlug) {
        setSnapshot(undefined);
        setSelectedTopicName(undefined);
        setTopicDraft(undefined);
      }
      return;
    }
    void loadSnapshot();
    // The settings dialog owns the active panel lifecycle. A project slug is
    // intentionally the only key that triggers a project Memory request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, projectSlug]);

  const topicCount = snapshot?.topics.length ?? 0;
  const sortedTopics = useMemo(
    () => [...(snapshot?.topics ?? [])].sort((left, right) => left.name.localeCompare(right.name)),
    [snapshot?.topics],
  );

  const patchMemoryConfig = (key: "useMemory" | "autoLearning", value: boolean) => {
    onChange(withDraft(config, (draft) => {
      draft.memory = { ...defaultMemoryConfig(), ...(draft.memory as unknown as Record<string, unknown> | undefined), [key]: value } as ServerConfig["memory"];
    }));
  };

  const savePreferences = async () => {
    if (!projectSlug) return;
    setSavingPreferences(true);
    setError(undefined);
    setConflict(undefined);
    try {
      await putMemoryPreferences({ slug: projectSlug, content: preferencesDraft, expectedRevision: preferences?.revision ?? null });
      await loadSnapshot();
    } catch (cause) {
      if (isRevisionConflict(cause)) setConflict("Personal Memory changed elsewhere. Your draft is still here; reload the latest version before saving.");
      else setError(toMemoryError(cause, "Unable to save Personal Memory"));
    } finally {
      setSavingPreferences(false);
    }
  };

  const clearPreferences = async () => {
    if (!projectSlug) return;
    setSavingPreferences(true);
    setError(undefined);
    setConflict(undefined);
    try {
      await deleteMemoryPreferences({ slug: projectSlug, expectedRevision: preferences?.revision ?? null });
      await loadSnapshot();
      setDeleteTarget(null);
    } catch (cause) {
      if (isRevisionConflict(cause)) setConflict("Personal Memory changed elsewhere. Reload before deleting it.");
      else setError(toMemoryError(cause, "Unable to clear Personal Memory"));
    } finally {
      setSavingPreferences(false);
    }
  };

  const selectTopic = async (summary: MemoryTopicSummary) => {
    if (!projectSlug) return;
    setSelectedTopicName(summary.name);
    setLoadingTopic(true);
    setError(undefined);
    setConflict(undefined);
    try {
      const topic = await getMemoryTopic(projectSlug, summary.name);
      setTopicDraft(toTopicDraft(topic, false));
    } catch (cause) {
      setError(toMemoryError(cause, `Unable to load topic ${summary.name}`));
      setTopicDraft(undefined);
    } finally {
      setLoadingTopic(false);
    }
  };

  const startNewTopic = () => {
    setSelectedTopicName(undefined);
    setConflict(undefined);
    setTopicDraft({ name: "", title: "", type: "project", description: "", content: "", revision: null, isNew: true });
  };

  const saveTopic = async () => {
    if (!projectSlug || !topicDraft) return;
    const name = topicDraft.name.trim();
    if (!name) {
      setError("Topic name is required");
      return;
    }
    setSavingTopic(true);
    setError(undefined);
    setConflict(undefined);
    try {
      await putMemoryTopic({
        slug: projectSlug,
        name,
        content: topicDraft.content,
        expectedRevision: topicDraft.revision,
        type: topicDraft.type,
        title: topicDraft.title,
        description: topicDraft.description,
      });
      setSelectedTopicName(name);
      await loadSnapshot();
      const refreshed = await getMemoryTopic(projectSlug, name);
      setTopicDraft(toTopicDraft(refreshed, false));
    } catch (cause) {
      if (isRevisionConflict(cause)) setConflict(`Topic ${name} changed elsewhere. Your draft is still here; reload the latest version before saving.`);
      else setError(toMemoryError(cause, `Unable to save topic ${name}`));
    } finally {
      setSavingTopic(false);
    }
  };

  const deleteTopic = async () => {
    if (!projectSlug || !topicDraft) return;
    setSavingTopic(true);
    setError(undefined);
    setConflict(undefined);
    try {
      await deleteMemoryTopic({ slug: projectSlug, name: topicDraft.name, expectedRevision: topicDraft.revision });
      setDeleteTarget(null);
      setSelectedTopicName(undefined);
      setTopicDraft(undefined);
      await loadSnapshot();
    } catch (cause) {
      if (isRevisionConflict(cause)) setConflict(`Topic ${topicDraft.name} changed elsewhere. Reload before deleting it.`);
      else setError(toMemoryError(cause, `Unable to delete topic ${topicDraft.name}`));
    } finally {
      setSavingTopic(false);
    }
  };

  const reloadAfterConflict = async () => {
    setConflict(undefined);
    await loadSnapshot();
    if (projectSlug && selectedTopicName) {
      const latest = await getMemoryTopic(projectSlug, selectedTopicName).catch(() => undefined);
      if (latest) setTopicDraft(toTopicDraft(latest, false));
    }
  };

  return <section data-settings-section="memory" className="space-y-5 pb-1">
    <MemoryPanelHeader />
    <div className="space-y-3 rounded-md border border-border-default bg-bg-surface p-4">
      <SettingsToggle checked={memory.useMemory} onChange={(value) => patchMemoryConfig("useMemory", value)} label="Use Memory" description="Inject complete preferences and the current project index into new Execution prompts." />
      <SettingsToggle checked={memory.autoLearning} onChange={(value) => patchMemoryConfig("autoLearning", value)} label="Auto learning" description="After a successful root conversation is idle for 10 minutes, extract durable Memory in the background." />
      <p className="border-t border-border-subtle pt-3 text-[11px] leading-4 text-text-tertiary">These switches are saved with the global configuration. Auto learning never removes or changes explicit <code className="font-mono text-text-secondary">memory_write</code>.</p>
    </div>

    {!projectSlug ? <UnavailableMemoryState /> : <>
      {loading && !snapshot && <p role="status" className="text-[12px] text-text-tertiary">Loading Memory…</p>}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {conflict && <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-warning/30 bg-warning-muted px-3 py-2.5 text-[12px] leading-5 text-warning" role="alert"><span>{conflict}</span><button type="button" className={secondaryButtonClass} onClick={() => { void reloadAfterConflict(); }}><RefreshCw size={13} aria-hidden="true" />Reload latest</button></div>}
      {snapshot && <>
        {snapshot.warnings.length > 0 && <WarningList warnings={snapshot.warnings} />}
        <PersonalMemoryEditor
          preferences={preferences}
          draft={preferencesDraft}
          onDraftChange={setPreferencesDraft}
          onSave={() => { void savePreferences(); }}
          onClear={() => setDeleteTarget("preferences")}
          saving={savingPreferences}
          error={errors["memory.preferences"]}
        />
        <ProjectMemoryEditor
          topics={sortedTopics}
          topicCount={topicCount}
          snapshot={snapshot}
          selectedTopicName={selectedTopicName}
          topicDraft={topicDraft}
          loadingTopic={loadingTopic}
          saving={savingTopic}
          onSelect={selectTopic}
          onNew={startNewTopic}
          onDraftChange={setTopicDraft}
          onSave={() => { void saveTopic(); }}
          onDelete={() => setDeleteTarget("topic")}
        />
      </>}
    </>}

    <DestructiveActionDialog
      open={deleteTarget === "preferences"}
      title="Clear Personal Memory?"
      description="This removes the complete preferences file. It cannot be undone."
      subject="Personal Memory"
      confirmLabel="Clear Memory"
      pendingLabel="Clearing…"
      consequences={["Personal preferences and working-style notes", "The current preferences revision"]}
      pending={savingPreferences}
      onClose={() => setDeleteTarget(null)}
      onConfirm={() => { void clearPreferences(); }}
    />
    <DestructiveActionDialog
      open={deleteTarget === "topic"}
      title="Delete Memory topic?"
      description="The topic file will be removed and the generated index rebuilt."
      subject={topicDraft?.name ?? "Selected topic"}
      confirmLabel="Delete topic"
      pendingLabel="Deleting…"
      consequences={["The complete topic Markdown file", "Its generated index entry"]}
      pending={savingTopic}
      onClose={() => setDeleteTarget(null)}
      onConfirm={() => { void deleteTopic(); }}
    />
  </section>;
}

function MemoryPanelHeader() {
  return <header className="border-b border-border-subtle pb-4">
    <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">Server settings</p>
    <h1 className="text-[16px] font-semibold leading-[22px] text-text-primary">Memory</h1>
    <p className="mt-1 text-[13px] leading-5 text-text-tertiary">Control prompt recall and background learning, then manage durable Markdown Memory for the open project.</p>
  </header>;
}

function SettingsToggle({ checked, onChange, label, description }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description: string }) {
  return <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-sm border border-border-subtle bg-bg-elevated px-3 py-3 transition-colors duration-[var(--motion-hover)] hover:border-border-default sm:min-h-0">
    <input type="checkbox" aria-label={label} checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1 h-4 w-4 accent-brand" />
    <span className="flex flex-col gap-1"><span className="text-[13px] font-medium text-text-secondary">{label}</span><span className="text-[11px] leading-4 text-text-tertiary">{description}</span></span>
  </label>;
}

function UnavailableMemoryState() {
  return <div className="rounded-md border border-border-default bg-bg-surface px-4 py-5" data-memory-unavailable>
    <div className="flex items-start gap-3"><BookOpen className="mt-0.5 shrink-0 text-text-tertiary" size={18} aria-hidden="true" /><div><h2 className="text-[13px] font-semibold text-text-primary">Open a project to manage Memory</h2><p className="mt-1 text-[12px] leading-5 text-text-tertiary">Personal Memory and project topics are scoped to the current project context. Open a project first; these controls remain unavailable on Home.</p></div></div>
  </div>;
}

function WarningList({ warnings }: { warnings: MemorySnapshot["warnings"] }) {
  return <div className="space-y-2" role="status" aria-label="Memory warnings">
    {warnings.map((warning, index) => <div key={`${warning.code}-${warning.target ?? "memory"}-${index}`} className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-muted px-3 py-2.5 text-[12px] leading-5 text-warning"><TriangleAlert className="mt-0.5 shrink-0" size={15} aria-hidden="true" /><span>{warning.message}</span></div>)}
  </div>;
}

function InlineMessage({ tone, children }: { tone: "error" | "success"; children: string }) {
  return <div role="alert" className={`rounded-md border px-3 py-2.5 text-[12px] leading-5 ${tone === "error" ? "border-error/30 bg-error-muted text-error" : "border-success/30 bg-success-muted text-success"}`}>{children}</div>;
}

function PersonalMemoryEditor({ preferences, draft, onDraftChange, onSave, onClear, saving, error }: { preferences: MemoryPreferencesItem | null; draft: string; onDraftChange: (value: string) => void; onSave: () => void; onClear: () => void; saving: boolean; error?: string }) {
  const capacity = preferences?.capacity;
  // Capacity is a projection of the current draft, not the last saved file.
  // Preferences are stored as-is, so their UTF-8 byte count is sufficient.
  const usedBytes = utf8ByteLength(draft);
  const maxBytes = capacity?.maxBytes ?? 8 * 1024;
  return <section className="space-y-3 rounded-md border border-border-default bg-bg-surface p-4" aria-labelledby="personal-memory-heading">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="personal-memory-heading" className="text-[14px] font-semibold text-text-primary">Personal Memory</h2><p className="mt-1 text-[12px] leading-5 text-text-tertiary">User-global preferences and working style. Edit the Markdown body directly.</p></div><MemoryCapacityLabel used={usedBytes} max={maxBytes} /></div>
    <textarea aria-label="Personal Memory" value={draft} onChange={(event) => onDraftChange(event.target.value)} rows={8} className="min-h-40 w-full resize-y rounded-sm border border-border-control bg-bg-base px-3 py-3 font-mono text-[12px] leading-[18px] text-text-primary outline-none transition-colors duration-[var(--motion-hover)] placeholder:text-text-tertiary hover:border-text-secondary focus:border-brand focus:ring-2 focus:ring-brand-subtle" />
    {error && <p role="alert" className="text-[11px] text-error">{error}</p>}
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[11px] text-text-tertiary">Revision {preferences?.revision ?? "new"}</span><div className="flex flex-wrap gap-2"><button type="button" className={dangerButtonClass} onClick={onClear} disabled={saving || ((preferences?.content.length ?? 0) === 0 && draft.length === 0)}><Trash2 size={13} aria-hidden="true" />Clear</button><button type="button" className={buttonClass} onClick={onSave} disabled={saving || draft === (preferences?.content ?? "")}><Save size={13} aria-hidden="true" />{saving ? "Saving…" : "Save Personal Memory"}</button></div></div>
  </section>;
}

function ProjectMemoryEditor({ topics, topicCount, snapshot, selectedTopicName, topicDraft, loadingTopic, saving, onSelect, onNew, onDraftChange, onSave, onDelete }: { topics: MemoryTopicSummary[]; topicCount: number; snapshot: MemorySnapshot; selectedTopicName?: string; topicDraft?: TopicDraft; loadingTopic: boolean; saving: boolean; onSelect: (topic: MemoryTopicSummary) => void; onNew: () => void; onDraftChange: (draft: TopicDraft | undefined) => void; onSave: () => void; onDelete: () => void }) {
  const topicCapacity = selectedTopicName === undefined ? undefined : topics.find((topic) => topic.name === selectedTopicName)?.capacity;
  const maxTopics = snapshot.index.topicCount.max;
  const topicsBlocked = !snapshot.index.topicCount.canCreate || topicCount >= maxTopics;
  return <section className="space-y-3 rounded-md border border-border-default bg-bg-surface p-4" aria-labelledby="project-memory-heading">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="project-memory-heading" className="text-[14px] font-semibold text-text-primary">Current Project Memory</h2><p className="mt-1 text-[12px] leading-5 text-text-tertiary">Topics are managed one file at a time. The index is generated by the server and read-only.</p></div><div className="flex items-center gap-2"><span className="rounded-sm border border-border-subtle bg-bg-elevated px-2 py-1 text-[11px] text-text-tertiary">{topicCount}/{maxTopics} topics</span><button type="button" className={secondaryButtonClass} onClick={onNew} disabled={topicsBlocked}><Plus size={13} aria-hidden="true" />New topic</button></div></div>
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(180px,0.8fr)_minmax(0,1.5fr)]">
      <div className="min-w-0 overflow-hidden rounded-sm border border-border-subtle bg-bg-base"><div className="border-b border-border-subtle px-3 py-2"><p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">Topics</p></div>{topics.length === 0 ? <p className="px-3 py-4 text-[12px] text-text-tertiary">No project topics yet.</p> : <div className="max-h-72 overflow-y-auto">{topics.map((topic) => <button key={topic.name} type="button" onClick={() => onSelect(topic)} aria-current={selectedTopicName === topic.name ? "true" : undefined} className={`flex min-h-11 w-full items-start justify-between gap-2 border-b border-border-subtle px-3 py-2.5 text-left transition-colors duration-[var(--motion-hover)] last:border-b-0 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand sm:min-h-0 ${selectedTopicName === topic.name ? "bg-selection-field" : ""}`}><span className="min-w-0"><span className="block truncate text-[12px] font-medium text-text-primary">{topic.name}</span><span className="mt-0.5 block truncate text-[11px] text-text-tertiary">{topic.description || topic.type || "Topic"}</span></span><span className="shrink-0 font-mono text-[10px] text-text-tertiary">{formatBytes(topic.capacity.bytes)}</span></button>)}</div>}</div>
      <div className="min-w-0">{loadingTopic ? <p role="status" className="rounded-sm border border-border-subtle bg-bg-base px-3 py-4 text-[12px] text-text-tertiary">Loading topic…</p> : topicDraft ? <TopicForm draft={topicDraft} topicCapacity={topicCapacity} saving={saving} onChange={onDraftChange} onSave={onSave} onDelete={onDelete} /> : <div className="flex min-h-40 items-center justify-center rounded-sm border border-dashed border-border-default bg-bg-base px-4 text-center text-[12px] leading-5 text-text-tertiary">Select a topic to view its complete Markdown, or create a new topic.</div>}</div>
    </div>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-subtle pt-3 text-[11px] text-text-tertiary"><span className="inline-flex items-center gap-1.5"><Check size={13} className="text-success" aria-hidden="true" />Index generated by server</span><span>{formatBytes(snapshot.index.bytes)} index · read-only navigation</span></div>
  </section>;
}

function TopicForm({ draft, topicCapacity, saving, onChange, onSave, onDelete }: { draft: TopicDraft; topicCapacity?: MemoryCapacity; saving: boolean; onChange: (draft: TopicDraft) => void; onSave: () => void; onDelete: () => void }) {
  // The server measures the complete canonical Markdown document, including
  // frontmatter. Mirror that tiny formatter here so edits and new topics show
  // the bytes that would actually be written.
  const usedBytes = utf8ByteLength(formatTopicDraftDocument(draft));
  const maxBytes = topicCapacity?.maxBytes ?? 16 * 1024;
  return <div className="space-y-3 rounded-sm border border-border-subtle bg-bg-base p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">{draft.isNew ? "New topic" : "Topic editor"}</p><p className="mt-1 text-[11px] text-text-tertiary">The server rebuilds index.md after each successful change.</p></div><MemoryCapacityLabel used={usedBytes} max={maxBytes} /></div><div className="grid gap-3 sm:grid-cols-2"><Field label="Name"><TextInput value={draft.name} readOnly={!draft.isNew} onChange={(name) => onChange({ ...draft, name })} /></Field><Field label="Title"><TextInput value={draft.title} onChange={(title) => onChange({ ...draft, title })} /></Field><label className="flex min-w-0 flex-col gap-2 text-[12px] font-medium leading-4 text-text-secondary"><span>Type</span><select className={selectClass} value={draft.type} onChange={(event) => onChange({ ...draft, type: event.target.value as TopicType })}><option value="user">User</option><option value="feedback">Feedback</option><option value="project">Project</option><option value="reference">Reference</option></select></label></div><Field label="Description"><TextInput value={draft.description} onChange={(description) => onChange({ ...draft, description })} /></Field><label className="flex min-w-0 flex-col gap-2 text-[12px] font-medium leading-4 text-text-secondary"><span>Markdown content</span><textarea aria-label="Topic Markdown content" value={draft.content} onChange={(event) => onChange({ ...draft, content: event.target.value })} rows={10} className="min-h-48 w-full resize-y rounded-sm border border-border-control bg-bg-elevated px-3 py-3 font-mono text-[12px] leading-[18px] text-text-primary outline-none transition-colors duration-[var(--motion-hover)] placeholder:text-text-tertiary hover:border-text-secondary focus:border-brand focus:ring-2 focus:ring-brand-subtle" /></label><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[11px] text-text-tertiary">Revision {draft.revision ?? "new"}</span><div className="flex flex-wrap gap-2">{!draft.isNew && <button type="button" className={dangerButtonClass} onClick={onDelete} disabled={saving}><Trash2 size={13} aria-hidden="true" />Delete topic</button>}<button type="button" className={buttonClass} onClick={onSave} disabled={saving}><Save size={13} aria-hidden="true" />{saving ? "Saving…" : draft.isNew ? "Create topic" : "Save topic"}</button></div></div></div>;
}

function MemoryCapacityLabel({ used, max }: { used: number; max: number }) {
  const ratio = max > 0 ? Math.min(1, used / max) : 1;
  const over = used > max;
  return <span className={`inline-flex items-center gap-2 rounded-sm border px-2 py-1 text-[11px] ${over ? "border-warning/30 bg-warning-muted text-warning" : "border-border-subtle bg-bg-elevated text-text-tertiary"}`} role="status" aria-label={`Memory capacity: ${formatBytes(used)} of ${formatBytes(max)}`}><span aria-hidden="true" className="h-1.5 w-12 overflow-hidden rounded-full bg-bg-active"><span className={`block h-full ${over ? "bg-warning" : "bg-brand"}`} style={{ width: `${Math.max(3, ratio * 100)}%` }} /></span>{formatBytes(used)} / {formatBytes(max)}</span>;
}

function toTopicDraft(topic: MemoryTopicItem, isNew: boolean): TopicDraft {
  return { name: topic.name, title: topic.title, type: topic.type, description: topic.description, content: topic.content, revision: topic.revision, isNew };
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Mirrors the server's canonical topic formatter and route normalization:
 * trimmed title/description, title fallback to the normalized name, fixed
 * frontmatter field order, and the formatter's exact newline placement.
 */
function formatTopicDraftDocument(draft: TopicDraft): string {
  const name = draft.name.trim();
  const title = draft.title.trim() || name;
  const description = draft.description.trim();
  return `---\nname: ${title}\ndescription: ${description}\ntype: ${draft.type}\n---\n${draft.content}`;
}

function formatBytes(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  return `${(value / 1024).toFixed(value >= 10_240 ? 0 : 1)} KiB`;
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.code === "MEMORY_REVISION_CONFLICT");
}

function toMemoryError(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 422) return error.message;
  return error instanceof Error ? error.message : fallback;
}
