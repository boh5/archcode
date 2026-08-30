import { z } from "zod";
import { buildToolCatalog, buildToolSearchIndex, searchToolCatalog } from "../src/agents/tool-visibility";
import { TOOL_SEARCH_EVAL_CASES } from "../src/agents/tool-visibility/search-eval-cases";

const ENTRY_COUNT = 1_000;
const QUERY_COUNT = 100;
const WARMUP_RUNS = 20;
const MEASURED_RUNS = 10;

const catalog = await buildToolCatalog(Array.from({ length: ENTRY_COUNT }, (_, index) => {
  const name = `synthetic_tool_${index.toString().padStart(4, "0")}`;
  const evalCase = TOOL_SEARCH_EVAL_CASES[index % TOOL_SEARCH_EVAL_CASES.length]!;
  return {
    sourceKind: index % 3 === 0 ? "mcp" as const : "builtin" as const,
    namespace: index % 3 === 0 ? `server-${index % 17}` : "builtin",
    registryName: name,
    descriptor: {
      name,
      description: `${evalCase.query}; deterministic synthetic capability number ${index}`,
      inputSchema: z.object({ value: z.string().describe(`Synthetic input ${index}`).optional() }),
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      outputPolicy: { kind: "inline" as const, previewDirection: "head" as const },
      execute: () => ({ isError: false, draft: { kind: "text" as const, text: "ok" } }),
    },
  };
}));

const queries = Array.from({ length: QUERY_COUNT }, (_, index) =>
  TOOL_SEARCH_EVAL_CASES[index % TOOL_SEARCH_EVAL_CASES.length]!.query
);

function runOnce(): number {
  const started = performance.now();
  const index = buildToolSearchIndex(catalog);
  for (const query of queries) searchToolCatalog(index, { query, limit: 5 });
  return performance.now() - started;
}

for (let index = 0; index < WARMUP_RUNS; index += 1) runOnce();
const durations = Array.from({ length: MEASURED_RUNS }, runOnce).sort((a, b) => a - b);
const percentile = (fraction: number): number => durations[Math.ceil(fraction * durations.length) - 1]!;
const p50 = percentile(0.5);
const p95 = percentile(0.95);
console.log(JSON.stringify({
  entries: ENTRY_COUNT,
  queries: QUERY_COUNT,
  warmupRuns: WARMUP_RUNS,
  measuredRuns: MEASURED_RUNS,
  p50Ms: Number(p50.toFixed(2)),
  p95Ms: Number(p95.toFixed(2)),
  thresholdMs: 1_000,
  passed: p50 < 1_000,
}, null, 2));
if (p50 >= 1_000) process.exitCode = 1;
