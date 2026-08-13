import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import type {
  ExecutionModelBindingSummary,
  ModelRuntimeCatalog,
  ModelRuntimeModelDescriptor,
  RequestedModelSelection,
  SessionNextModelSelection,
} from "@archcode/protocol";

export interface ModelPickerProps {
  catalog: ModelRuntimeCatalog;
  next: SessionNextModelSelection;
  active?: ExecutionModelBindingSummary;
  onSelect: (selection: RequestedModelSelection) => void;
  disabled?: boolean;
}

type CatalogModelEntry = {
  model: ModelRuntimeModelDescriptor;
  providerId: string;
  providerDisplayName: string;
};

const MODEL_SEARCH_THRESHOLD = 8;

function findCatalogModel(
  catalog: ModelRuntimeCatalog,
  qualifiedId: string,
): ModelRuntimeModelDescriptor | undefined {
  return catalog.providers
    .flatMap((provider) => provider.models)
    .find((model) => model.qualifiedId === qualifiedId);
}

function movePickerFocus(
  event: React.KeyboardEvent<HTMLElement>,
  root: HTMLDivElement | null,
): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const fromOption = event.target instanceof HTMLElement
    && event.target.hasAttribute("data-picker-option");
  if (!fromOption && (event.key === "Home" || event.key === "End")) return;
  const options = Array.from(
    root?.querySelectorAll<HTMLButtonElement>("[data-picker-option]:not(:disabled)") ?? [],
  );
  if (options.length === 0) return;

  const currentIndex = options.indexOf(event.target as HTMLButtonElement);
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? options.length - 1
      : event.key === "ArrowUp"
        ? currentIndex <= 0 ? options.length - 1 : currentIndex - 1
        : currentIndex < 0 || currentIndex === options.length - 1 ? 0 : currentIndex + 1;
  event.preventDefault();
  options[nextIndex]?.focus();
}

export function ModelPicker({
  catalog,
  next,
  active,
  onSelect,
  disabled = false,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showNextNotice, setShowNextNotice] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const focusSelectionOnOpenRef = useRef(false);
  const principalProfile = catalog.profileDefaults.principal;
  const currentModel = findCatalogModel(catalog, next.resolved.selection.model);
  const currentVariant = next.resolved.selection.variant;

  const catalogModels = useMemo<CatalogModelEntry[]>(
    () => catalog.providers.flatMap((provider) => provider.models.map((model) => ({
      model,
      providerId: provider.id,
      providerDisplayName: provider.displayName,
    }))),
    [catalog.providers],
  );
  const supportsSearch = catalogModels.length > MODEL_SEARCH_THRESHOLD;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleModels = useMemo(() => catalogModels.filter(({ model, providerId, providerDisplayName }) => (
    normalizedQuery.length === 0
    || model.id.toLocaleLowerCase().includes(normalizedQuery)
    || model.displayName.toLocaleLowerCase().includes(normalizedQuery)
    || model.qualifiedId.toLocaleLowerCase().includes(normalizedQuery)
    || providerId.toLocaleLowerCase().includes(normalizedQuery)
    || providerDisplayName.toLocaleLowerCase().includes(normalizedQuery)
  )), [catalogModels, normalizedQuery]);
  const activeDiffers = active !== undefined && (
    active.selection.model !== next.resolved.selection.model
    || active.selection.variant !== next.resolved.selection.variant
  );
  const nextSelectionKey = [
    next.requested.mode,
    next.requested.selection.model,
    next.requested.selection.variant ?? "",
  ].join("\0");
  const previousNextSelectionKeyRef = useRef(nextSelectionKey);

  useEffect(() => {
    if (previousNextSelectionKeyRef.current === nextSelectionKey) return;
    previousNextSelectionKeyRef.current = nextSelectionKey;
    setShowNextNotice(activeDiffers);
  }, [activeDiffers, nextSelectionKey]);

  useEffect(() => {
    if (!showNextNotice) return;
    const timeout = window.setTimeout(() => setShowNextNotice(false), 2_400);
    return () => window.clearTimeout(timeout);
  }, [showNextNotice]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setQuery("");
      queueMicrotask(() => triggerRef.current?.focus());
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    const focusSelection = focusSelectionOnOpenRef.current;
    focusSelectionOnOpenRef.current = false;
    if (focusSelection) {
      queueMicrotask(() => {
        popoverRef.current
          ?.querySelector<HTMLElement>('button[data-model][aria-pressed="true"]')
          ?.focus();
      });
    }
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (catalog.revision !== next.resolved.modelRuntimeRevision) {
      setOpen(false);
      setQuery("");
      setShowNextNotice(false);
    }
  }, [catalog.revision, next.resolved.modelRuntimeRevision]);

  const select = (selection: RequestedModelSelection) => {
    onSelect(selection);
  };
  const selectModel = (model: ModelRuntimeModelDescriptor) => {
    if (next.resolved.selection.model === model.qualifiedId) return;
    select({ mode: "session_override", selection: { model: model.qualifiedId } });
  };
  const selectVariant = (variant?: string) => {
    if (currentVariant === variant) return;
    select({
      mode: "session_override",
      selection: {
        model: next.resolved.selection.model,
        ...(variant === undefined ? {} : { variant }),
      },
    });
  };

  const nextModelLabel = next.resolved.modelDisplayName || next.resolved.modelId;
  const nextVariantLabel = currentVariant ?? "Default";
  const hasEffort = (currentModel?.variants.length ?? 0) > 0;
  const activeLabel = active ? active.modelDisplayName || active.modelId : undefined;
  const triggerLabel = hasEffort
    ? `${nextModelLabel} · ${nextVariantLabel}`
    : nextModelLabel;

  if (catalog.revision !== next.resolved.modelRuntimeRevision) {
    return <span className="max-w-[180px] truncate" data-testid="model-picker-refreshing">Refreshing model configuration…</span>;
  }

  return (
    <div ref={rootRef} className="relative z-[5] flex min-w-0 max-w-[min(240px,42vw)] items-center" data-testid="model-picker">
      {showNextNotice && !open && (
        <span
          role="status"
          className="pointer-events-none absolute bottom-[calc(100%+6px)] right-0 z-40 whitespace-nowrap rounded-sm border border-border-default bg-bg-overlay px-2 py-1 text-[11px] text-text-secondary shadow-md animate-overlay-enter motion-reduce:animate-none"
          data-testid="model-picker-next-notice"
        >
          Applies to the next execution
        </span>
      )}

      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="model-picker-popover"
        aria-label={activeDiffers && activeLabel
          ? `Choose next model and effort, ${triggerLabel}; running ${activeLabel}`
          : `Choose model and effort, current ${triggerLabel}`}
        disabled={disabled}
        onPointerDown={() => {
          focusSelectionOnOpenRef.current = false;
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (!open && (event.key === "Enter" || event.key === " ")) {
            focusSelectionOnOpenRef.current = true;
            return;
          }
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          if (open) {
            popoverRef.current
              ?.querySelector<HTMLElement>('button[data-model][aria-pressed="true"]')
              ?.focus();
            return;
          }
          focusSelectionOnOpenRef.current = true;
          setOpen(true);
          setQuery("");
        }}
        onClick={() => {
          setOpen((current) => {
            if (current) focusSelectionOnOpenRef.current = false;
            return !current;
          });
          setQuery("");
        }}
        className={`inline-flex h-[30px] max-w-[112px] min-w-0 cursor-pointer items-center gap-1.5 rounded-[999px] px-2 pl-2.5 text-left text-[12px] font-[520] tracking-normal transition-[background-color,color] duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:cursor-not-allowed disabled:opacity-50 min-[421px]:max-w-[142px] min-[521px]:max-w-full ${open ? "bg-bg-hover text-text-primary" : "text-text-secondary"}`}
        data-testid="model-picker-trigger"
        title={activeDiffers ? `Next: ${triggerLabel}` : triggerLabel}
      >
        <span className="inline-flex min-w-0 items-baseline gap-[5px] overflow-hidden">
          <span className={`truncate font-[560] tracking-[-0.01em] ${open ? "text-text-primary" : "text-text-secondary"}`}>{nextModelLabel}</span>
          {hasEffort ? <><span className="shrink-0 font-medium text-text-muted opacity-70" aria-hidden="true">·</span><span className="shrink-0 text-[11.5px] font-[520] tracking-[0.01em] text-text-tertiary">{nextVariantLabel}</span></> : null}
        </span>
        <ChevronDown
          size={11}
          strokeWidth={1.75}
          className={`shrink-0 text-text-muted transition-transform duration-[var(--motion-icon)] motion-reduce:transition-none ${open ? "rotate-180 text-text-secondary" : ""}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          ref={popoverRef}
          id="model-picker-popover"
          role="dialog"
          aria-label="Choose model and effort"
          onKeyDown={(event) => movePickerFocus(event, popoverRef.current)}
          className="absolute bottom-[calc(100%+8px)] right-0 z-50 flex max-h-[min(70vh,440px)] w-[min(308px,calc(100vw-28px))] flex-col overflow-hidden rounded-[12px] border border-border-default bg-bg-overlay p-1.5 text-[15px] leading-[1.55] tracking-[-0.006em] animate-overlay-enter motion-reduce:animate-none min-[761px]:left-auto [@media(max-width:520px)]:fixed [@media(max-width:520px)]:bottom-[72px] [@media(max-width:520px)]:left-auto [@media(max-width:520px)]:right-3 [@media(max-width:520px)]:w-[min(308px,calc(100vw-72px))]"
          style={{ boxShadow: "0 18px 40px rgb(0 0 0 / 28%), 0 6px 16px rgb(0 0 0 / 14%), inset 0 0 0 1px rgb(255 255 255 / 4%)" }}
          data-testid="model-picker-popover"
        >
          {supportsSearch && (
            <>
              <label className="mx-0.5 flex h-8 items-center rounded-md px-2 text-text-tertiary focus-within:bg-bg-elevated">
                <Search size={13} strokeWidth={1.75} className="pointer-events-none shrink-0" aria-hidden="true" />
                <span className="sr-only">Search models</span>
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search models…"
                  className="h-full min-w-0 flex-1 bg-transparent px-2 text-[12px] text-text-primary outline-none placeholder:text-text-muted"
                />
              </label>
              <div className="mx-1 my-1 h-px bg-border-subtle" aria-hidden="true" />
            </>
          )}

          <div className="min-h-0 overflow-y-auto overscroll-contain">
            <section className="grid gap-0.5 p-0.5" aria-label="Model">
              <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-[650] uppercase tracking-[0.06em] text-text-tertiary">Model</div>
            {visibleModels.map(({ model, providerDisplayName }) => {
              const selected = next.resolved.selection.model === model.qualifiedId;
              const isDefault = principalProfile?.model === model.qualifiedId;
              return (
                <button
                  type="button"
                  key={model.qualifiedId}
                  data-picker-option
                  aria-pressed={selected}
                  disabled={disabled}
                  onClick={() => selectModel(model)}
                  className="grid min-h-[34px] w-full cursor-pointer grid-cols-[minmax(0,1fr)_16px] items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-text-secondary outline-none transition-[background-color,color] duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus:bg-bg-hover focus:text-text-primary [@media(pointer:coarse)]:min-h-11"
                  style={selected ? { background: "color-mix(in srgb, var(--brand) 10%, var(--bg-hover))" } : undefined}
                  data-model={model.qualifiedId}
                  title={`${model.displayName} — ${providerDisplayName}`}
                >
                  <span className="flex min-w-0 items-center gap-2"><strong className={`min-w-0 truncate text-[13px] tracking-[-0.01em] ${selected ? "font-semibold text-text-primary" : "font-[560]"}`}>{model.displayName}</strong>{isDefault && <span className="shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold leading-[1.4] tracking-[0.02em] text-text-tertiary shadow-[inset_0_0_0_1px_var(--border-subtle)]" style={{ background: "color-mix(in srgb, var(--bg-base) 70%, var(--border-subtle))" }}>Default</span>}</span>
                  <span className="grid h-4 w-4 place-items-center">{selected ? <Check size={14} strokeWidth={2} className="text-brand" aria-label="Selected" /> : null}</span>
                </button>
              );
            })}
            {visibleModels.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">No models match “{query}”</div>
            )}
            </section>

            {normalizedQuery.length === 0 && currentModel && hasEffort && (
              <>
                <div className="mx-1.5 my-[5px] h-px bg-border-subtle" aria-hidden="true" />
                <section className="px-0.5 pb-0.5 pt-1" aria-label="Effort">
                <span className="px-2.5 pb-2 pt-0.5 text-[10px] font-[650] uppercase tracking-[0.06em] text-text-tertiary">Effort</span>
                <div
                  className="grid gap-[3px] rounded-[9px] p-[3px] shadow-[inset_0_0_0_1px_var(--border-subtle)]"
                  role="radiogroup"
                  aria-label="Effort"
                  style={{
                    gridTemplateColumns: `repeat(${currentModel.variants.length + 1}, minmax(0, 1fr))`,
                    background: "color-mix(in srgb, var(--bg-base) 88%, var(--border-subtle))",
                  }}
                >
                {[undefined, ...currentModel.variants].map((variant) => {
                  const selected = currentVariant === variant;
                  return (
                    <button
                      type="button"
                      role="radio"
                      key={variant ?? "default"}
                      data-picker-option
                      aria-checked={selected}
                      disabled={disabled}
                      onClick={() => selectVariant(variant)}
                      className={`inline-flex min-h-[30px] cursor-pointer items-center justify-center rounded-[7px] px-2 text-[12px] tracking-[-0.01em] outline-none transition-[background-color,color,box-shadow] duration-[var(--motion-hover)] focus-visible:[box-shadow:var(--focus)] disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-11 ${selected ? "bg-bg-elevated font-[620] text-text-primary shadow-[0_1px_2px_rgb(0_0_0/12%),0_0_0_1px_color-mix(in_srgb,var(--border-default)_70%,transparent)]" : "font-[560] text-text-tertiary hover:text-text-primary"}`}
                      data-variant={variant ?? ""}
                    >
                      <span className="truncate">{variant ?? "Default"}</span>
                    </button>
                  );
                })}
                </div>
                </section>
              </>
            )}

            {normalizedQuery.length === 0 && next.requested.mode === "session_override" && principalProfile && (
              <>
                <div className="mx-1 my-1 h-px bg-border-subtle" aria-hidden="true" />
                <button
                  type="button"
                  data-picker-option
                  disabled={disabled}
                  onClick={() => select({ mode: "profile_default", selection: principalProfile })}
                  className="mx-0.5 flex min-h-8 w-[calc(100%-4px)] cursor-pointer items-center rounded-lg px-2.5 py-1.5 text-left text-[11px] text-text-tertiary outline-none transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus:bg-bg-hover focus:text-text-primary [@media(pointer:coarse)]:min-h-11"
                  data-testid="model-picker-principal-profile"
                >
                  Reset explicit override
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
