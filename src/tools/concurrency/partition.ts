import type { ToolCallLike } from "../types";
import type { ToolRegistry } from "../registry";

// ─── Types ───

export type ToolCallBatch =
  | { type: "parallel"; calls: ToolCallLike[] }
  | { type: "serial"; call: ToolCallLike };

// ─── Implementation ───

/**
 * Partition tool calls into batches of parallel-safe and serial-only calls.
 *
 * Algorithm:
 * 1. Walk through calls in order.
 * 2. Concurrency-safe calls are grouped with adjacent safe calls into parallel batches.
 * 3. Unsafe calls become individual serial batches.
 * 4. Unknown tools (not found in registry) are treated as serial for safety.
 */
export function partitionToolCalls(
  calls: ToolCallLike[],
  registry: ToolRegistry,
): ToolCallBatch[] {
  const batches: ToolCallBatch[] = [];
  let currentParallelBatch: ToolCallLike[] = [];

  function flushParallel(): void {
    if (currentParallelBatch.length > 0) {
      batches.push({ type: "parallel", calls: currentParallelBatch });
      currentParallelBatch = [];
    }
  }

  for (const call of calls) {
    const descriptor = registry.get(call.toolName);
    const isConcurrencySafe = descriptor?.traits.concurrencySafe ?? false;

    if (isConcurrencySafe) {
      currentParallelBatch.push(call);
    } else {
      flushParallel();
      batches.push({ type: "serial", call });
    }
  }

  flushParallel();

  return batches;
}
