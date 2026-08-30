import type {
  InvalidLoadedToolRef,
  LoadedToolRef,
  ToolCatalog,
  ToolCatalogEntry,
} from "./types";
import { TOOL_SEARCH_NAME } from "./types";

export interface ProjectVisibleToolsInput {
  readonly catalog: ToolCatalog;
  readonly core: readonly string[];
  readonly state: readonly string[];
  readonly loaded: readonly LoadedToolRef[];
}

export interface ToolVisibilityProjection {
  readonly visible: readonly ToolCatalogEntry[];
  readonly deferred: readonly ToolCatalogEntry[];
  readonly invalidLoadedRefs: readonly InvalidLoadedToolRef[];
  readonly loaded: readonly ToolCatalogEntry[];
  readonly toolSearchVisible: boolean;
}

export function projectVisibleTools(input: ProjectVisibleToolsInput): ToolVisibilityProjection {
  const entriesByName = new Map(input.catalog.entries.map((entry) => [entry.registryName, entry]));
  const promoted = new Set([...input.core, ...input.state]);
  promoted.delete(TOOL_SEARCH_NAME);
  const loaded: ToolCatalogEntry[] = [];
  const invalidLoadedRefs: InvalidLoadedToolRef[] = [];
  const loadedNames = new Set<string>();

  for (const ref of stableLoadedRefs(input.loaded)) {
    if (ref.name === TOOL_SEARCH_NAME) {
      invalidLoadedRefs.push({ ...ref, reason: "tool_search_excluded" });
      continue;
    }
    const entry = entriesByName.get(ref.name);
    if (entry === undefined) {
      invalidLoadedRefs.push({ ...ref, reason: "missing" });
      continue;
    }
    if (entry.descriptorDigest !== ref.descriptorDigest) {
      invalidLoadedRefs.push({ ...ref, reason: "digest_changed" });
      continue;
    }
    if (!loadedNames.has(entry.registryName)) loaded.push(entry);
    loadedNames.add(entry.registryName);
  }

  const deferred = input.catalog.entries.filter((entry) =>
    entry.registryName !== TOOL_SEARCH_NAME &&
    !promoted.has(entry.registryName) &&
    !loadedNames.has(entry.registryName)
  );
  const toolSearchVisible = deferred.length > 0 && entriesByName.has(TOOL_SEARCH_NAME);
  const visibleNames = new Set([...promoted, ...loadedNames]);
  if (toolSearchVisible) visibleNames.add(TOOL_SEARCH_NAME);
  const visible = input.catalog.entries.filter((entry) => visibleNames.has(entry.registryName));
  return { visible, deferred, invalidLoadedRefs, loaded, toolSearchVisible };
}

function stableLoadedRefs(refs: readonly LoadedToolRef[]): readonly LoadedToolRef[] {
  return [...refs].sort((a, b) => (
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    || (a.descriptorDigest < b.descriptorDigest ? -1 : a.descriptorDigest > b.descriptorDigest ? 1 : 0)
  ));
}
