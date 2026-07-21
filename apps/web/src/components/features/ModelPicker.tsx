import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import type {
  ExecutionModelBindingSummary,
  ModelRuntimeCatalog,
  ModelRuntimeModelDescriptor,
  ModelSelectionRef,
  RequestedModelSelection,
  SessionNextModelSelection,
} from "@archcode/protocol";

export interface ModelPickerProps {
  catalog: ModelRuntimeCatalog;
  next: SessionNextModelSelection;
  active?: ExecutionModelBindingSummary;
  onSelect: (selection: RequestedModelSelection) => void;
  onManageModels: () => void;
  disabled?: boolean;
}

function sameSelection(left: ModelSelectionRef, right: ModelSelectionRef): boolean {
  return left.model === right.model && left.variant === right.variant;
}

function bindingLabel(binding: ExecutionModelBindingSummary): string {
  const model = binding.modelDisplayName || binding.modelId;
  return binding.selection.variant ? `${model} · ${binding.selection.variant}` : model;
}

function modeLabel(selection: RequestedModelSelection): string {
  return selection.mode === "profile_default" ? "Principal profile" : "Override";
}

function catalogSelectionLabel(model: ModelRuntimeModelDescriptor, variant?: string): string {
  return variant ? `${model.displayName} · ${variant}` : model.displayName;
}

function catalogRefLabel(catalog: ModelRuntimeCatalog, selection: ModelSelectionRef): string {
  const model = catalog.providers.flatMap((provider) => provider.models).find((candidate) => candidate.qualifiedId === selection.model);
  const displayName = model?.displayName ?? selection.model;
  return selection.variant ? `${displayName} · ${selection.variant}` : displayName;
}

export function ModelPicker({
  catalog,
  next,
  active,
  onSelect,
  onManageModels,
  disabled = false,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const principalProfile = catalog.profileDefaults.principal;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    queueMicrotask(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled || catalog.revision !== next.resolved.modelRuntimeRevision) setOpen(false);
  }, [catalog.revision, disabled, next.resolved.modelRuntimeRevision]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const providers = useMemo(() => catalog.providers.flatMap((provider) => {
    const providerMatches = normalizedQuery.length === 0
      || provider.id.toLocaleLowerCase().includes(normalizedQuery)
      || provider.displayName.toLocaleLowerCase().includes(normalizedQuery);
    const models = provider.models.flatMap((model) => {
      const modelMatches = providerMatches
        || model.id.toLocaleLowerCase().includes(normalizedQuery)
        || model.displayName.toLocaleLowerCase().includes(normalizedQuery)
        || model.qualifiedId.toLocaleLowerCase().includes(normalizedQuery);
      const variants = [undefined, ...model.variants].filter((variant) => modelMatches
        || (variant?.toLocaleLowerCase().includes(normalizedQuery) ?? false));
      return variants.length === 0 ? [] : [{ model, variants }];
    });
    return models.length === 0 ? [] : [{ provider, models }];
  }), [catalog.providers, normalizedQuery]);

  const select = (selection: RequestedModelSelection) => {
    onSelect(selection);
    setOpen(false);
    setQuery("");
  };
  const manageModels = () => {
    setOpen(false);
    setQuery("");
    onManageModels();
  };
  const runningDifferentModel = active !== undefined && !sameSelection(active.selection, next.resolved.selection);
  const nextLabel = bindingLabel(next.resolved);

  if (catalog.revision !== next.resolved.modelRuntimeRevision) {
    return <span className="max-w-[180px] truncate" data-testid="model-picker-refreshing">Refreshing model configuration…</span>;
  }

  return (
    <div ref={rootRef} className="relative min-w-0" data-testid="model-picker">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="model-picker-popover"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className="flex max-w-[260px] min-w-0 items-center gap-1 rounded-sm px-1.5 py-1 text-left text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 max-[390px]:max-w-[190px]"
        data-testid="model-picker-trigger"
      >
        <span className="truncate">{runningDifferentModel ? `Next: ${nextLabel}` : nextLabel}</span>
        <ChevronDown size={12} className="shrink-0" aria-hidden="true" />
      </button>

      {open && (
        <div
          id="model-picker-popover"
          role="dialog"
          aria-label="Choose model"
          className="absolute bottom-[calc(100%+8px)] left-0 z-50 flex max-h-[min(70vh,480px)] w-[min(360px,calc(100vw-24px))] flex-col overflow-hidden rounded-[12px] border border-border-default bg-bg-elevated shadow-lg max-[390px]:fixed max-[390px]:bottom-[72px] max-[390px]:left-3 max-[390px]:right-3 max-[390px]:w-auto"
          data-testid="model-picker-popover"
        >
          <div className="grid gap-1 border-b border-border-subtle bg-bg-surface px-3 py-2.5 text-[11px]">
            {active && (
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="text-text-muted">Running with</span>
                <span className="truncate font-medium text-text-secondary">{bindingLabel(active)}</span>
              </div>
            )}
            <div className="flex min-w-0 items-center justify-between gap-3">
              <span className="text-text-muted">Next</span>
              <div className="flex min-w-0 items-center gap-1.5 font-medium text-text-primary">
                <span className="truncate">{bindingLabel(next.resolved)}</span>
                <span className="shrink-0 text-text-muted" data-testid="model-picker-next-mode">· {modeLabel(next.requested)}</span>
              </div>
            </div>
          </div>

          <label className="relative block border-b border-border-subtle p-2">
            <Search size={13} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden="true" />
            <span className="sr-only">Search models</span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search providers, models, variants…"
              className="h-8 w-full rounded-md border border-border-default bg-bg-base pl-8 pr-3 text-[12px] text-text-primary outline-none placeholder:text-text-muted focus:border-accent"
            />
          </label>

          <div className="min-h-0 overflow-y-auto overscroll-contain p-1.5">
            <button
              type="button"
              disabled={!principalProfile}
              onClick={() => {
                if (principalProfile) select({ mode: "profile_default", selection: principalProfile });
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="model-picker-principal-profile"
            >
              <span className="flex-1">
                <span className="block text-[12.5px] font-medium text-text-primary">Principal profile</span>
                <span className="block truncate text-[10.5px] text-text-muted">
                  {principalProfile ? catalogRefLabel(catalog, principalProfile) : "Principal profile is unavailable"}
                </span>
              </span>
              {principalProfile && next.requested.mode === "profile_default" && <Check size={13} className="shrink-0 text-accent" aria-label="Selected" />}
            </button>

            <div className="my-1 h-px bg-border-subtle" />

            {providers.map(({ provider, models }) => (
              <section key={provider.id} aria-label={provider.displayName} className="py-1">
                <div className="flex items-center justify-between gap-2 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
                  <span className="truncate">{provider.displayName}</span>
                  <span className="truncate font-mono font-normal normal-case tracking-normal">{provider.id}</span>
                </div>
                {models.flatMap(({ model, variants }) => variants.map((variant) => {
                  const selection = { model: model.qualifiedId, ...(variant ? { variant } : {}) };
                  const selected = next.requested.mode === "session_override" && sameSelection(next.requested.selection, selection);
                  return (
                    <button
                      type="button"
                      key={`${model.qualifiedId}\0${variant ?? "default"}`}
                      onClick={() => select({ mode: "session_override", selection })}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent"
                      data-model={model.qualifiedId}
                      data-variant={variant ?? ""}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] text-text-primary">{catalogSelectionLabel(model, variant)}</span>
                        <span className="block truncate font-mono text-[10px] text-text-muted">{model.qualifiedId}</span>
                      </span>
                      {selected && <Check size={13} className="shrink-0 text-accent" aria-label="Selected" />}
                    </button>
                  );
                }))}
              </section>
            ))}

            {providers.length === 0 && (
              <div className="px-3 py-7 text-center text-[12px] text-text-muted">No models match “{query}”</div>
            )}
          </div>

          <div className="border-t border-border-subtle p-1.5">
            <button
              type="button"
              onClick={manageModels}
              className="w-full rounded-md px-2.5 py-2 text-left text-[12px] font-medium text-accent hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-accent"
            >
              Manage models…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
