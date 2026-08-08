---
name: research-docs
description: Research external documentation into implementation guidance when library, API, or platform behavior is uncertain during integration or external-spec design.
license: MIT
metadata:
  archcode/source: "ArchCode documentation research method"
  archcode/source-commit: "f00efe7ab3cd87f951797d9b4bf14415f10abd7a"
  archcode/adaptation: "original rewrite"
---

Use a bounded, source-first investigation to answer one implementation question. The
deliverable is concise guidance with traceable links, not a pasted documentation dump.

For source ranking, version conflicts, direct-link requirements, and stopping criteria, read [references/source-evaluation.md](references/source-evaluation.md).

1. Define the question, target package/platform, project language, and the behavior
   the implementation must support. Read the repository manifest and lockfile when
   available to establish the exact dependency/runtime version; if it is unavailable,
   state that limitation.
2. Start with the **official** API reference, specification, migration/release notes,
   and repository examples for that version. Prefer a direct page or stable source
   URL over a search-result page. Use reputable OSS examples only to fill a gap after
   official material has been checked, and label them as secondary evidence.
3. Extract only the facts needed to implement: API names and signatures, parameter
   types, defaults, lifecycle/order rules, errors, limits, compatibility, and
   version-sensitive behavior. Record the source title, direct link, and documented
   version for every material claim.
4. Keep confirmed facts, local observations, and inferences separate. Mark an
   inference explicitly and explain what evidence would verify it. Do not silently
   turn an example or a remembered default into a project fact.
5. When sources conflict, first check whether they describe different versions or
   platforms. Prefer the official documentation for the project's exact version;
   if official sources still disagree, report the discrepancy, use a minimal local
   compile/test/probe when safe, and leave the result as unresolved rather than
   guessing.
6. Convert the result into short, ordered implementation steps with the relevant
   constraints and validation checks. Include one minimal, copy-ready example only
   when it clarifies a non-obvious API shape; adapt it to the project's language and
   do not require large copied passages or full source listings.
7. End with open questions, version mismatches, inaccessible sources, or risks that
   could change the recommendation. Link the official pages inline so the consumer
   can verify them without repeating the search.

Stop when the target version, required API shape, defaults/constraints, and a safe
validation path are established and no blocking unknown remains. If sources are
unavailable, contradictory, or require unbounded investigation, stop after a small
number of reasonable attempts, report the blocker and evidence gathered, and let the
implementing agent decide whether a local experiment is authorized. Never hide an
unsupported guess behind confident prose.
