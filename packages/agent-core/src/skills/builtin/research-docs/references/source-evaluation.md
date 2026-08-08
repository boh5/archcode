# Source evaluation and stopping rules

Rank evidence: exact-version official reference or specification first; official release notes and repository examples next; reputable open-source usage only to fill an official gap. Link directly to the source page, not a result page, for every material claim.

## Evidence record

For each material implementation claim, capture:

| Field | Content |
| --- | --- |
| Question | One behavior, default, constraint, or API shape |
| Project version/platform | Lockfile or manifest evidence, or explicit unknown |
| Source | Direct official page/repository link and documented version |
| Fact | Narrow paraphrase supported by that source |
| Local implication | File/interface/validation affected in this repository |
| Confidence / gap | Confirmed, version-matched, inferred, or unresolved |
| Verification | Minimal compile, test, request, or runtime observation |

Do not cite a landing page for a claim found only on a nested API page. Search results, snippets, generated summaries, and third-party examples are discovery aids, not primary evidence.

When sources conflict, first identify version or platform differences. Prefer the official source matching the project's installed version. If that remains contradictory, state it and propose one bounded local probe when safe; do not guess.

Example conflict handling:

1. Docs for the latest release show a new option, but the lockfile pins an older release.
2. Check the pinned release reference and release notes for the introduction version.
3. If the pinned source lacks the option, report it as unavailable rather than copying the latest example.
4. When types and prose disagree at the same version, inspect the official implementation or run a minimal compile/probe and label the result as local observation.

## Minimal example quality

A copy-ready example contains only the imports, inputs, call, result/error handling, and lifecycle ordering needed to demonstrate the non-obvious contract. Remove unrelated setup. Mark placeholders and never include secrets. State the version and what the example does not establish.

Stop when version, required API shape, constraints/defaults, and a validation path are known. Stop earlier with an explicit limitation after a small reasonable investigation if the source is unavailable or the question is unbounded.
