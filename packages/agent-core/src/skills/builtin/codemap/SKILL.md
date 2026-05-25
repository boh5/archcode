---
name: codemap
description: Build a concise map of code ownership, flows, and extension points.
when_to_use: Use before implementation when orientation matters - entering an unfamiliar module, understanding data flow, finding extension points, or planning where to make changes.
---

- Trace entry points: main exports, route handlers, CLI commands, or public API surfaces.
- Follow the primary data flow from input to output, noting key transformations and boundary crossings.
- Record which files own core behavior versus adapters, presentation, or configuration.
- Identify extension points: plugin hooks, strategy patterns, middleware chains, and callback registrations.
- Note circular dependencies or tight couplings that limit safe modification.
- Call out invariants, assumptions, and constraints a new contributor might miss.
- Prefer short, actionable maps tied to the specific task over broad directory listings.
- Update the map if exploration reveals structure diverges from initial assumptions.