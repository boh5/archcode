import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { AlertTriangle, LoaderCircle, Search } from "lucide-react";
import {
  classifyToolOutputError,
  isTerminalToolOutputError,
  readToolOutput,
  searchToolOutput,
  type ToolOutputReadRecord,
  type ToolOutputSearchMatch,
} from "../../api/tool-outputs";

const READ_PAGE_LIMIT = 200;
const SEARCH_PAGE_LIMIT = 50;
const MAX_VISIBLE_RECORDS = 1_000;
const MAX_VISIBLE_MATCHES = 500;

type ReadState =
  | { readonly status: "loading"; readonly records: readonly ToolOutputReadRecord[] }
  | {
      readonly status: "ready";
      readonly records: readonly ToolOutputReadRecord[];
      readonly nextCursor?: string;
      readonly gap?: { readonly canonicalStart: number; readonly canonicalEnd: number };
      readonly completeness: "complete" | "partial";
      readonly limitReached?: true;
    }
  | { readonly status: "terminal"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

type SearchState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly pattern: string; readonly matches: readonly ToolOutputSearchMatch[] }
  | {
      readonly status: "ready";
      readonly pattern: string;
      readonly matches: readonly ToolOutputSearchMatch[];
      readonly nextCursor?: string;
      readonly completeness: "complete" | "partial_artifact";
      readonly limitReached?: true;
    }
  | { readonly status: "terminal"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

export interface ToolOutputViewerProps {
  readonly projectSlug: string;
  readonly sessionId: string;
  readonly outputRef: string;
}

export function ToolOutputViewer({ projectSlug, sessionId, outputRef }: ToolOutputViewerProps) {
  const [readState, setReadState] = useState<ReadState>({ status: "loading", records: [] });
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<SearchState>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    setReadState({ status: "loading", records: [] });
    setSearchState({ status: "idle" });
    void readToolOutput({ projectSlug, sessionId, outputRef, limit: READ_PAGE_LIMIT })
      .then((page) => {
        if (cancelled) return;
        setReadState({
          status: "ready",
          records: page.records,
          nextCursor: page.nextCursor,
          gap: page.gap,
          completeness: page.completeness,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setReadState(createReadErrorState(error));
      });
    return () => { cancelled = true; };
  }, [outputRef, projectSlug, sessionId]);

  async function loadNext(): Promise<void> {
    if (readState.status !== "ready" || !readState.nextCursor) return;
    const previous = readState;
    setReadState({ status: "loading", records: previous.records });
    try {
      const page = await readToolOutput({
        projectSlug,
        sessionId,
        outputRef,
        cursor: previous.nextCursor,
        limit: READ_PAGE_LIMIT,
      });
      const records = [...previous.records, ...page.records].slice(0, MAX_VISIBLE_RECORDS);
      const limitReached = records.length >= MAX_VISIBLE_RECORDS && page.nextCursor !== undefined;
      setReadState({
        status: "ready",
        records,
        nextCursor: limitReached ? undefined : page.nextCursor,
        gap: page.gap ?? previous.gap,
        completeness: page.completeness,
        ...(limitReached ? { limitReached: true } : {}),
      });
    } catch (error) {
      setReadState(createReadErrorState(error));
    }
  }

  async function runSearch(event: FormEvent): Promise<void> {
    event.preventDefault();
    const pattern = query.trim();
    if (!pattern) return;
    setSearchState({ status: "loading", pattern, matches: [] });
    try {
      const page = await searchToolOutput({
        projectSlug,
        sessionId,
        outputRef,
        pattern,
        limit: SEARCH_PAGE_LIMIT,
      });
      setSearchState({
        status: "ready",
        pattern,
        matches: page.matches,
        nextCursor: page.nextCursor,
        completeness: page.searchCompleteness,
      });
    } catch (error) {
      setSearchState(createSearchErrorState(error));
    }
  }

  async function loadNextSearchPage(): Promise<void> {
    if (searchState.status !== "ready" || !searchState.nextCursor) return;
    const previous = searchState;
    setSearchState({ status: "loading", pattern: previous.pattern, matches: previous.matches });
    try {
      const page = await searchToolOutput({
        projectSlug,
        sessionId,
        outputRef,
        pattern: previous.pattern,
        cursor: previous.nextCursor,
        limit: SEARCH_PAGE_LIMIT,
      });
      const matches = [...previous.matches, ...page.matches].slice(0, MAX_VISIBLE_MATCHES);
      const limitReached = matches.length >= MAX_VISIBLE_MATCHES && page.nextCursor !== undefined;
      setSearchState({
        status: "ready",
        pattern: previous.pattern,
        matches,
        nextCursor: limitReached ? undefined : page.nextCursor,
        completeness: page.searchCompleteness,
        ...(limitReached ? { limitReached: true } : {}),
      });
    } catch (error) {
      setSearchState(createSearchErrorState(error));
    }
  }

  if (readState.status === "terminal") {
    return (
      <div data-testid="tool-output-expired" className="flex items-center gap-2 px-3 py-3 text-[12px] text-warning">
        <AlertTriangle size={13} />
        <span>{readState.message}</span>
      </div>
    );
  }

  return (
    <div data-testid="tool-output-viewer" className="border-t border-border-subtle bg-bg-surface">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <span className="font-mono text-[11px] text-text-muted truncate">{outputRef}</span>
        {readState.status === "ready" && (
          <span className="ml-auto text-[10.5px] text-text-muted">{readState.completeness}</span>
        )}
      </div>

      <form className="flex gap-1.5 border-b border-border-subtle px-3 py-2" onSubmit={runSearch}>
        <label className="sr-only" htmlFor={`tool-output-search-${outputRef}`}>Search output</label>
        <input
          id={`tool-output-search-${outputRef}`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search this output"
          className="min-w-0 flex-1 rounded-sm border border-border-default bg-bg-base px-2 py-1 text-[11.5px] text-text-primary outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={!query.trim() || searchState.status === "loading"}
          className="inline-flex items-center gap-1 rounded-sm bg-bg-active px-2 py-1 text-[11px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
        >
          <Search size={11} /> Search
        </button>
      </form>

      {searchState.status !== "idle" && (
        <div className="border-b border-border-subtle px-3 py-2">
          {(searchState.status === "loading" || searchState.status === "ready") && (
            <div className="flex flex-col gap-1.5">
              {searchState.matches.map((match, index) => (
                <div key={`${match.outputRef}-${match.canonicalStart}-${index}`} className="rounded-sm border border-border-subtle bg-bg-elevated px-2 py-1.5">
                  <div className="mb-0.5 font-mono text-[10px] text-text-muted">{match.segment} · {match.canonicalStart}–{match.canonicalEnd}</div>
                  <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-text-secondary">{match.snippet}</pre>
                </div>
              ))}
              {searchState.status === "loading" && <LoadingLabel label="Searching…" />}
              {searchState.status === "ready" && searchState.matches.length === 0 && (
                <span className="text-[11px] text-text-muted">No matches</span>
              )}
              {searchState.status === "ready" && searchState.nextCursor && (
                <button type="button" onClick={loadNextSearchPage} className="self-start text-[11px] text-accent hover:underline">More matches</button>
              )}
              {searchState.status === "ready" && searchState.limitReached && (
                <span className="text-[10.5px] text-text-muted">Viewer limit reached. Refine the search to continue.</span>
              )}
            </div>
          )}
          {searchState.status === "terminal" && (
            <div data-testid="tool-output-expired" className="flex items-center gap-1.5 text-[11px] text-warning">
              <AlertTriangle size={11} /> {searchState.message}
            </div>
          )}
          {searchState.status === "error" && <span className="text-[11px] text-error">{searchState.message}</span>}
        </div>
      )}

      <div className="max-h-80 overflow-y-auto px-3 py-2">
        {readState.status === "error" && <span className="text-[11px] text-error">{readState.message}</span>}
        {(readState.status === "loading" || readState.status === "ready") && (
          <div className="flex flex-col gap-1.5">
            {readState.records.map((record, index) => (
              <div key={`${record.segment}-${record.canonicalStart}-${index}`}>
                <div className="mb-0.5 font-mono text-[10px] text-text-muted">{record.segment} · {record.canonicalStart}–{record.canonicalEnd}</div>
                <pre className="whitespace-pre-wrap break-all rounded-sm border border-border-subtle bg-bg-elevated p-2 font-mono text-[11.5px] leading-relaxed text-text-secondary">{record.text}</pre>
              </div>
            ))}
            {readState.status === "ready" && readState.gap && (
              <div className="rounded-sm border border-warning/20 bg-warning-muted px-2 py-1 text-[10.5px] text-warning">
                Omitted canonical range {readState.gap.canonicalStart}–{readState.gap.canonicalEnd}
              </div>
            )}
            {readState.status === "loading" && <LoadingLabel label="Loading output…" />}
            {readState.status === "ready" && readState.records.length === 0 && (
              <span className="text-[11px] text-text-muted">No output records</span>
            )}
            {readState.status === "ready" && readState.nextCursor && (
              <button type="button" onClick={loadNext} className="self-start text-[11px] text-accent hover:underline">Continue loading</button>
            )}
            {readState.status === "ready" && readState.limitReached && (
              <span className="text-[10.5px] text-text-muted">Viewer limit reached. Use search to narrow the output.</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LoadingLabel({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-text-muted">
      <LoaderCircle size={11} className="animate-spin" /> {label}
    </span>
  );
}

function createReadErrorState(error: unknown): ReadState {
  if (isTerminalToolOutputError(error)) {
    return { status: "terminal", message: terminalMessage(classifyToolOutputError(error)) };
  }
  return { status: "error", message: error instanceof Error ? error.message : "Unable to read tool output" };
}

function createSearchErrorState(error: unknown): SearchState {
  if (isTerminalToolOutputError(error)) {
    return { status: "terminal", message: terminalMessage(classifyToolOutputError(error)) };
  }
  return { status: "error", message: error instanceof Error ? error.message : "Unable to search tool output" };
}

function terminalMessage(code: ReturnType<typeof classifyToolOutputError>): string {
  switch (code) {
    case "TOOL_OUTPUT_EXPIRED": return "This output has expired.";
    case "TOOL_OUTPUT_EVICTED": return "This output was evicted to reclaim storage.";
    case "TOOL_OUTPUT_NOT_FOUND": return "This output was not found and is no longer available.";
    default: return "This output is no longer available.";
  }
}
