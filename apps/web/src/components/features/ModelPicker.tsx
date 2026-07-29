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

type OpenPicker = "model" | "variant";

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

function pickerPopoverClass(width: string, mobileWidth: string, alignment: string): string {
  return `absolute bottom-[calc(100%+6px)] ${alignment} z-50 flex max-h-[min(70vh,384px)] ${width} flex-col overflow-hidden rounded-lg border border-border-default bg-bg-overlay p-1 shadow-md animate-overlay-enter motion-reduce:animate-none [@media(max-width:520px)]:fixed [@media(max-width:520px)]:bottom-[72px] [@media(max-width:520px)]:left-auto [@media(max-width:520px)]:right-3 ${mobileWidth}`;
}

function movePickerFocus(
  event: React.KeyboardEvent<HTMLElement>,
  root: HTMLDivElement | null,
): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const options = Array.from(
    root?.querySelectorAll<HTMLButtonElement>("[data-picker-option]:not(:disabled)") ?? [],
  );
  if (options.length === 0) return;

  const currentIndex = options.indexOf(event.target as HTMLButtonElement);
  let nextIndex: number;
  if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = options.length - 1;
  else if (event.key === "ArrowUp") {
    nextIndex = currentIndex <= 0 ? options.length - 1 : currentIndex - 1;
  } else {
    nextIndex = currentIndex < 0 || currentIndex === options.length - 1 ? 0 : currentIndex + 1;
  }

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
  const [openPicker, setOpenPicker] = useState<OpenPicker>();
  const [query, setQuery] = useState("");
  const [showNextNotice, setShowNextNotice] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const variantTriggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const modelPopoverRef = useRef<HTMLDivElement>(null);
  const variantPopoverRef = useRef<HTMLDivElement>(null);
  const principalProfile = catalog.profileDefaults.principal;
  const currentModel = findCatalogModel(catalog, next.resolved.selection.model);
  const hasVariants = (currentModel?.variants.length ?? 0) > 0;

  const catalogModels = useMemo<CatalogModelEntry[]>(
    () => catalog.providers.flatMap((provider) => provider.models.map((model) => ({
      model,
      providerId: provider.id,
      providerDisplayName: provider.displayName,
    }))),
    [catalog.providers],
  );
  const supportsSearch = catalogModels.length > MODEL_SEARCH_THRESHOLD;
  const duplicateDisplayNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { model } of catalogModels) {
      const key = model.displayName.toLocaleLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [catalogModels]);
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
    if (!openPicker) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenPicker(undefined);
        setQuery("");
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const trigger = openPicker === "model"
        ? modelTriggerRef.current
        : variantTriggerRef.current;
      setOpenPicker(undefined);
      setQuery("");
      queueMicrotask(() => trigger?.focus());
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    queueMicrotask(() => {
      if (openPicker === "model" && supportsSearch) {
        searchRef.current?.focus();
        return;
      }
      const popover = openPicker === "model"
        ? modelPopoverRef.current
        : variantPopoverRef.current;
      const selected = popover?.querySelector<HTMLElement>('[aria-pressed="true"]');
      (selected ?? popover?.querySelector<HTMLElement>("[data-picker-option]"))?.focus();
    });

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openPicker, supportsSearch]);

  useEffect(() => {
    if (disabled || catalog.revision !== next.resolved.modelRuntimeRevision) {
      setOpenPicker(undefined);
      setQuery("");
      setShowNextNotice(false);
    }
  }, [catalog.revision, disabled, next.resolved.modelRuntimeRevision]);

  const closePicker = () => {
    setOpenPicker(undefined);
    setQuery("");
  };
  const select = (selection: RequestedModelSelection) => {
    onSelect(selection);
    closePicker();
  };
  const selectModel = (model: ModelRuntimeModelDescriptor) => {
    if (next.resolved.selection.model === model.qualifiedId) {
      closePicker();
      return;
    }
    select({
      mode: "session_override",
      selection: { model: model.qualifiedId },
    });
  };
  const selectVariant = (variant?: string) => {
    if (next.resolved.selection.variant === variant) {
      closePicker();
      return;
    }
    select({
      mode: "session_override",
      selection: {
        model: next.resolved.selection.model,
        ...(variant === undefined ? {} : { variant }),
      },
    });
  };

  const activeModelDiffers = active !== undefined
    && active.selection.model !== next.resolved.selection.model;
  const activeModelLabel = active
    ? active.modelDisplayName || active.modelId
    : undefined;
  const nextModelLabel = next.resolved.modelDisplayName || next.resolved.modelId;
  const nextVariantLabel = next.resolved.selection.variant ?? "Default";
  const effectiveVariant = next.resolved.selection.variant;

  if (catalog.revision !== next.resolved.modelRuntimeRevision) {
    return <span className="max-w-[180px] truncate" data-testid="model-picker-refreshing">Refreshing model configuration…</span>;
  }

  return (
    <div
      ref={rootRef}
      className="relative flex min-w-0 items-center gap-0.5"
      data-testid="model-picker"
    >
      {showNextNotice && !openPicker && (
        <span
          role="status"
          className="pointer-events-none absolute bottom-[calc(100%+6px)] right-0 z-40 whitespace-nowrap rounded-sm border border-border-default bg-bg-overlay px-2 py-1 text-[10px] text-text-secondary shadow-md animate-overlay-enter motion-reduce:animate-none"
          data-testid="model-picker-next-notice"
        >
          Applies to the next execution
        </span>
      )}

      <button
        ref={modelTriggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={openPicker === "model"}
        aria-controls="model-picker-popover"
        aria-label={activeModelDiffers && activeModelLabel
          ? `Choose next model, ${nextModelLabel}; running ${activeModelLabel}`
          : `Choose model, current ${nextModelLabel}`}
        disabled={disabled}
        onClick={() => {
          setOpenPicker((current) => current === "model" ? undefined : "model");
          setQuery("");
        }}
        className={`flex h-7 max-w-[190px] min-w-0 cursor-pointer items-center gap-1 rounded-sm px-1.5 text-left text-[11px] font-medium transition-[background-color,color] duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50 max-[520px]:max-w-[108px] max-[420px]:max-w-[88px] ${
          openPicker === "model" ? "bg-bg-hover text-text-primary" : "text-text-secondary"
        }`}
        data-testid="model-picker-trigger"
        title={activeModelDiffers ? `Next model: ${nextModelLabel}` : nextModelLabel}
      >
        <span className="truncate">{nextModelLabel}</span>
        <ChevronDown
          size={11}
          strokeWidth={1.75}
          className={`shrink-0 text-text-muted transition-transform duration-[var(--motion-hover)] motion-reduce:transition-none ${
            openPicker === "model" ? "rotate-180" : ""
          }`}
          aria-hidden="true"
        />
      </button>

      {hasVariants && (
        <button
          ref={variantTriggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={openPicker === "variant"}
          aria-controls="variant-picker-popover"
          aria-label={activeDiffers
            ? `Choose next variant for ${nextModelLabel}, ${nextVariantLabel}`
            : `Choose variant for ${nextModelLabel}, current ${nextVariantLabel}`}
          disabled={disabled}
          onClick={() => {
            setOpenPicker((current) => current === "variant" ? undefined : "variant");
            setQuery("");
          }}
          className={`flex h-7 max-w-[88px] min-w-0 cursor-pointer items-center gap-1 rounded-sm px-1.5 text-left text-[11px] transition-[background-color,color] duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50 max-[520px]:max-w-[72px] max-[420px]:max-w-[64px] ${
            openPicker === "variant" ? "bg-bg-hover text-text-primary" : "text-text-tertiary"
          }`}
          data-testid="variant-picker-trigger"
          title={activeDiffers ? `Next variant: ${nextVariantLabel}` : nextVariantLabel}
        >
          <span className="truncate">{nextVariantLabel}</span>
          <ChevronDown
            size={11}
            strokeWidth={1.75}
            className={`shrink-0 text-text-muted transition-transform duration-[var(--motion-hover)] motion-reduce:transition-none ${
              openPicker === "variant" ? "rotate-180" : ""
            }`}
            aria-hidden="true"
          />
        </button>
      )}

      {openPicker === "model" && (
        <div
          ref={modelPopoverRef}
          id="model-picker-popover"
          role="dialog"
          aria-label="Choose model"
          onKeyDown={(event) => movePickerFocus(event, modelPopoverRef.current)}
          className={pickerPopoverClass(
            "w-[288px] max-w-[calc(100vw-24px)]",
            "[@media(max-width:520px)]:w-[min(288px,calc(100vw-72px))]",
            "right-0 min-[761px]:left-0 min-[761px]:right-auto",
          )}
          data-testid="model-picker-popover"
        >
          {supportsSearch && (
            <>
              <label className="flex h-8 items-center rounded-sm px-2 text-text-tertiary focus-within:bg-bg-elevated">
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
            {next.requested.mode === "session_override" && principalProfile && (
              <>
                <button
                  type="button"
                  data-picker-option
                  onClick={() => select({ mode: "profile_default", selection: principalProfile })}
                  className="flex h-8 w-full cursor-pointer items-center rounded-sm px-2.5 text-left text-[11px] text-text-tertiary outline-none transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus:bg-bg-hover focus:text-text-primary"
                  data-testid="model-picker-principal-profile"
                >
                  Use Principal default
                </button>
                <div className="mx-1 my-1 h-px bg-border-subtle" aria-hidden="true" />
              </>
            )}

            {visibleModels.map(({ model, providerDisplayName }) => {
              const selected = next.resolved.selection.model === model.qualifiedId;
              const duplicateName = (duplicateDisplayNames.get(model.displayName.toLocaleLowerCase()) ?? 0) > 1;
              return (
                <button
                  type="button"
                  key={model.qualifiedId}
                  data-picker-option
                  aria-pressed={selected}
                  onClick={() => selectModel(model)}
                  className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2.5 text-left text-[12px] text-text-secondary outline-none transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus:bg-bg-hover focus:text-text-primary"
                  data-model={model.qualifiedId}
                  title={duplicateName ? `${model.displayName} — ${providerDisplayName}` : model.displayName}
                >
                  <span className={`min-w-0 flex-1 truncate ${selected ? "font-medium text-text-primary" : ""}`}>
                    {model.displayName}
                  </span>
                  {duplicateName && (
                    <span className="max-w-[88px] shrink-0 truncate text-[10px] text-text-tertiary">
                      {providerDisplayName}
                    </span>
                  )}
                  {selected && <Check size={13} strokeWidth={2} className="shrink-0 text-brand" aria-label="Selected" />}
                </button>
              );
            })}

            {visibleModels.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">No models match “{query}”</div>
            )}
          </div>
        </div>
      )}

      {openPicker === "variant" && currentModel && (
        <div
          ref={variantPopoverRef}
          id="variant-picker-popover"
          role="dialog"
          aria-label={`Choose variant for ${nextModelLabel}`}
          onKeyDown={(event) => movePickerFocus(event, variantPopoverRef.current)}
          className={pickerPopoverClass(
            "w-[152px]",
            "[@media(max-width:520px)]:w-[min(152px,calc(100vw-72px))]",
            "right-0",
          )}
          data-testid="variant-picker-popover"
        >
          {[undefined, ...currentModel.variants].map((variant) => {
            const selected = effectiveVariant === variant;
            return (
              <button
                type="button"
                key={variant ?? "default"}
                data-picker-option
                aria-pressed={selected}
                onClick={() => selectVariant(variant)}
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2.5 text-left text-[12px] text-text-secondary outline-none transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus:bg-bg-hover focus:text-text-primary"
                data-variant={variant ?? ""}
              >
                <span className={`min-w-0 flex-1 truncate ${selected ? "font-medium text-text-primary" : ""}`}>
                  {variant ?? "Default"}
                </span>
                {selected && <Check size={13} strokeWidth={2} className="shrink-0 text-brand" aria-label="Selected" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
