---
name: codemap
description: Build a concise evidence-backed map of code ownership, flows, and extension points when orienting in an unfamiliar module or planning a change.
license: MIT
metadata:
  archcode/source: "OMO Slim codemap concepts"
  archcode/source-commit: "ecb4f55e87c7cea9f18759eaca0eff8fb7edf1d0"
  archcode/adaptation: "idea-only rewrite"
---

Build a slim, evidence-backed map for the task at hand. Map behavior and ownership, not every directory or an imagined architecture. Use [references/evidence-map-example.md](references/evidence-map-example.md) for the target output shape.

1. **Set the boundary.** Name the module, feature, or question being mapped and the
   caller who will use the result. Start with the smallest relevant search surface;
   widen it only when the call path or ownership is still unclear.
2. **Trace entry points.** Find main exports, route handlers, CLI commands, event
   consumers, scheduled jobs, or public API surfaces. Record the concrete file and
   symbol (and line or command evidence when useful). If no true entry point exists,
   say so rather than inventing one.
3. **Assign responsibilities.** Identify which files or modules own domain rules,
   state and persistence, orchestration, adapters/integrations, presentation, and
   configuration. Distinguish the source of truth from wrappers and re-exports.
4. **Follow the call chain.** Walk the primary path from entry point to observable
   output, including important transforms, validation, error paths, event emission,
   and persistence boundaries. Keep the order explicit and name the symbols that
   make each hop.
5. **Describe the data flow.** State the input shape, normalization or validation,
   state changes, messages/events, external calls, and final output. Note where data
   crosses package, process, network, or storage boundaries.
6. **List integration points.** Include registries, middleware and hook chains,
   plugin/strategy/callback extension points, providers, queues, files, databases,
   APIs, and test seams. Note circular dependencies or tight couplings that make a
   change risky.
7. **Record invariants and assumptions.** Call out schema and type contracts,
   authorization and workspace boundaries, lifecycle/concurrency rules, required
   ordering, compatibility constraints, and assumptions a new contributor could
   otherwise break. Label an inference as an inference.
8. **Assess the impact surface.** Identify direct callers and consumers, transitive
   effects, tests, configuration, migrations, API/UI contracts, and documentation
   likely to change. Rank the surface by relevance to the requested change instead
   of listing unrelated files.
9. **Update after probing.** If exploration disproves the initial map, revise it and
   explain the correction. Stop when the relevant path, ownership, integrations,
   invariants, and impact are sufficient for the task; leave concrete unknowns and
   the next narrow probe when they are not.

Tie each material claim to a file, symbol, test, or command. Keep the map short and
actionable; avoid broad directory dumps and unsupported speculation.
