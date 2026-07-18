import type { ModelRuntimeCatalog, SessionNextModelSelection } from "@archcode/protocol";

/** Catalog-dependent UI is safe only when both snapshots describe the same live revision. */
export function coherentModelRuntime(
  catalog: ModelRuntimeCatalog | undefined,
  next: SessionNextModelSelection | undefined,
  isCatalogFetching: boolean,
): ModelRuntimeCatalog | undefined {
  if (isCatalogFetching || catalog === undefined || next === undefined) return undefined;
  return catalog.revision === next.resolved.modelRuntimeRevision ? catalog : undefined;
}
