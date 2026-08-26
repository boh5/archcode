import { searchableCatalogEntries } from "./catalog";
import type { ToolCatalog, ToolCatalogEntry, ToolSearchQuery, ToolSearchResult } from "./types";
import { MAX_TOOL_SEARCH_RESULTS } from "./types";

interface IndexedEntry {
  readonly entry: ToolCatalogEntry;
  readonly terms: ReadonlyMap<string, number>;
  readonly length: number;
  readonly trigrams: ReadonlySet<string>;
  readonly normalizedName: string;
  readonly normalizedQualifiedName: string;
}

export interface ToolSearchIndex {
  readonly catalogDigest: string;
  readonly entries: readonly IndexedEntry[];
  readonly documentFrequency: ReadonlyMap<string, number>;
  readonly averageLength: number;
}

export function buildToolSearchIndex(catalog: ToolCatalog): ToolSearchIndex {
  const entries = searchableCatalogEntries(catalog).map((entry): IndexedEntry => {
    const tokens = tokenize(entry.searchText);
    return {
      entry,
      terms: frequencies(tokens),
      length: tokens.length,
      trigrams: trigrams(normalizeCharacters(entry.searchText)),
      normalizedName: normalizeName(entry.registryName),
      normalizedQualifiedName: normalizeName(`${entry.namespace} ${entry.registryName}`),
    };
  });
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const entry of entries) {
    totalLength += entry.length;
    for (const term of entry.terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  return {
    catalogDigest: catalog.digest,
    entries,
    documentFrequency,
    averageLength: entries.length === 0 ? 0 : totalLength / entries.length,
  };
}

export function searchToolCatalog(
  index: ToolSearchIndex,
  input: ToolSearchQuery,
): readonly ToolSearchResult[] {
  const query = input.query.trim();
  if (query.length === 0) return [];
  const limit = Math.min(MAX_TOOL_SEARCH_RESULTS, Math.max(1, Math.trunc(input.limit ?? MAX_TOOL_SEARCH_RESULTS)));
  const queryTokens = tokenize(query);
  const queryTerms = frequencies(queryTokens);
  const queryCharacters = normalizeCharacters(query);
  const queryTrigrams = trigrams(queryCharacters);
  const normalizedQuery = normalizeName(query);
  const namespace = input.namespace?.trim();

  return index.entries
    .filter(({ entry }) => namespace === undefined || entry.namespace === namespace)
    .map((entry) => ({ entry, score: scoreEntry(index, entry, queryTerms, queryTrigrams, normalizedQuery) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || compareIdentity(a.entry.entry, b.entry.entry))
    .slice(0, limit)
    .map(({ entry, score }) => ({
      name: entry.entry.registryName,
      namespace: entry.entry.namespace,
      description: shortSummary(entry.entry.description),
      descriptorDigest: entry.entry.descriptorDigest,
      score,
    }));
}

function scoreEntry(
  index: ToolSearchIndex,
  candidate: IndexedEntry,
  queryTerms: ReadonlyMap<string, number>,
  queryTrigrams: ReadonlySet<string>,
  normalizedQuery: string,
): number {
  let score = 0;
  const documentCount = index.entries.length;
  for (const [term, queryFrequency] of queryTerms) {
    const termFrequency = candidate.terms.get(term) ?? 0;
    if (termFrequency === 0) continue;
    const documentFrequency = index.documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
    const lengthNorm = index.averageLength === 0 ? 1 : 1 - 0.75 + 0.75 * candidate.length / index.averageLength;
    score += queryFrequency * idf * (termFrequency * 2.2) / (termFrequency + 1.2 * lengthNorm);
  }
  const trigram = dice(queryTrigrams, candidate.trigrams);
  score += trigram * 5;
  if (normalizedQuery === candidate.normalizedName || normalizedQuery === candidate.normalizedQualifiedName) score += 100;
  else if (candidate.normalizedName.startsWith(normalizedQuery) || candidate.normalizedQualifiedName.startsWith(normalizedQuery)) score += 30;
  else if (normalizedQuery.startsWith(candidate.normalizedName)) score += 12;
  return score;
}

function tokenize(value: string): string[] {
  return value
    .normalize("NFKC")
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function normalizeCharacters(value: string): string {
  return tokenize(value).join(" ");
}

function normalizeName(value: string): string {
  return tokenize(value).join("_");
}

function trigrams(value: string): ReadonlySet<string> {
  const padded = `  ${value}  `;
  const result = new Set<string>();
  for (let index = 0; index <= padded.length - 3; index += 1) result.add(padded.slice(index, index + 3));
  return result;
}

function frequencies(values: readonly string[]): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const value of a) if (b.has(value)) overlap += 1;
  return 2 * overlap / (a.size + b.size);
}

function compareIdentity(a: ToolCatalogEntry, b: ToolCatalogEntry): number {
  return compareText(a.namespace, b.namespace) || compareText(a.registryName, b.registryName);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function shortSummary(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
}
