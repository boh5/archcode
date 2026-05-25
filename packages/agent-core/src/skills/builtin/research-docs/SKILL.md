---
name: research-docs
description: Research external documentation and turn it into implementation guidance.
when_to_use: Use when uncertain about library, API, or platform behavior - when integrating unfamiliar packages, or when designing against an external specification.
---

- Start with official documentation; fall back to reputable OSS examples only when docs are incomplete.
- Extract exact APIs, parameter types, default values, and version-sensitive behavior.
- Note which version of the library or platform the documentation describes; flag version mismatches.
- Separate confirmed facts from assumptions; label inferences explicitly for the consumer.
- When multiple sources conflict, prefer the official source and note the discrepancy.
- Convert findings into concise, ordered steps the implementing agent can follow immediately.
- Include copy-ready code snippets for non-obvious API usage; avoid paraphrasing working examples.
- Record open questions or areas where documentation was insufficient; do not silently guess.