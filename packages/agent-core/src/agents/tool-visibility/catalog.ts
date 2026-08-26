import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { ToolCatalog, ToolCatalogEntry, ToolCatalogInput } from "./types";
import { TOOL_SEARCH_NAME } from "./types";

export async function buildToolCatalog(inputs: readonly ToolCatalogInput[]): Promise<ToolCatalog> {
  const entries = await Promise.all(inputs.map(buildEntry));
  entries.sort(compareEntryIdentity);
  assertUniqueRegistryNames(entries);
  const digest = sha256(stableJson(entries.map((entry) => [
    entry.registryName,
    entry.descriptorDigest,
  ])));
  return { entries, digest };
}

async function buildEntry(input: ToolCatalogInput): Promise<ToolCatalogEntry> {
  if (input.registryName !== input.descriptor.name) {
    throw new Error(`Catalog registryName must match descriptor.name: ${input.registryName}`);
  }
  const aiJsonSchema = toJsonSchema(input.descriptor.aiInputSchema ?? input.descriptor.inputSchema);
  const canonical = {
    sourceKind: input.sourceKind,
    namespace: input.namespace,
    registryName: input.registryName,
    description: input.descriptor.description,
    aiJsonSchema,
    traits: input.descriptor.traits,
    outputPolicy: input.descriptor.outputPolicy,
  };
  return {
    sourceKind: input.sourceKind,
    namespace: input.namespace,
    registryName: input.registryName,
    description: input.descriptor.description,
    aiJsonSchema,
    descriptorDigest: sha256(stableJson(canonical)),
    descriptor: input.descriptor,
    searchText: buildSearchText(canonical),
  };
}

export function searchableCatalogEntries(catalog: ToolCatalog): readonly ToolCatalogEntry[] {
  return catalog.entries.filter((entry) => entry.registryName !== TOOL_SEARCH_NAME);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, sortJson(record[key])]),
    );
  }
  return value;
}

function buildSearchText(canonical: {
  readonly namespace: string;
  readonly registryName: string;
  readonly description: string;
  readonly aiJsonSchema: unknown;
}): string {
  const schemaTerms: string[] = [];
  collectSchemaTerms(canonical.aiJsonSchema, schemaTerms);
  return [
    canonical.namespace,
    canonical.registryName,
    canonical.description,
    ...schemaTerms,
  ].join(" ");
}

function collectSchemaTerms(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaTerms(item, output);
    return;
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") output.push(value);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "properties" && item !== null && typeof item === "object" && !Array.isArray(item)) {
      output.push(...Object.keys(item as Record<string, unknown>));
    }
    if (key === "description" || key === "enum" || key === "title" || key === "properties") {
      collectSchemaTerms(item, output);
    }
  }
}

function compareEntryIdentity(a: ToolCatalogEntry, b: ToolCatalogEntry): number {
  return compareText(a.namespace, b.namespace) || compareText(a.registryName, b.registryName);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertUniqueRegistryNames(entries: readonly ToolCatalogEntry[]): void {
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.registryName)) throw new Error(`Duplicate catalog tool: ${entry.registryName}`);
    names.add(entry.registryName);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toJsonSchema(schema: unknown): unknown {
  if (typeof schema === "object" && schema !== null && "jsonSchema" in schema) {
    return (schema as { readonly jsonSchema: unknown }).jsonSchema;
  }
  return z.toJSONSchema(schema as z.ZodType);
}
