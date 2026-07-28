# Session Attachment Support Progress

> Goal: `docs/goals/session-attachment-support-plan-goal.md`
> Status: completed
> Started: 2026-07-28

## Execution Log

### 2026-07-28 — Start

- Re-read the approved Goal and verified the worktree before implementation.
- Preserved unrelated untracked `.DS_Store` files.
- Split implementation by ownership:
  - protocol, durable Session input, and projection;
  - attachment storage, HTTP routes, and Runtime deletion coordination;
  - Web Composer, upload client, and attachment rendering;
  - Lead integration for model projection, tool read contracts, validation, and final review.
- Locked the simplified lifecycle boundary: one per-root upload/delete gate plus best-effort cleanup; no Session deletion refactor, startup scan, orphan cleanup, compatibility path, or feature flag.

### 2026-07-28 — Vertical implementation

- Added the fixed protocol limits, strict attachment descriptor/part shapes, durable pending/canonical message propagation, ordered idempotency fingerprints, attachment-only messages, and explicit Slash-command rejection.
- Added `.archcode/attachments/{rootSessionId}/{attachmentId}` storage with raw bounded streaming, strict metadata, fixed image-signature recognition, atomic finalization, same-ID replay checks, download headers, and root upload/delete coordination.
- Extended the canonical model-message projection with non-forgeable attachment slots; title, memory, and background-output projections reuse the same escaped marker without reading bytes.
- Added the Web upload client and Composer flow for selection, drop/paste, ordering, sequential upload, retry, attachment-only send, queued/timeline chips, and responsive states.
- Hardened `file_read` to accept only strict UTF-8 text without NUL under the existing 10 MiB limit, and added exact attachment-path exceptions to the existing workspace/Bash permission owners.
- Documented attachments as ordinary ignored workspace data outside `.archcode/runtime`.
- First-principles verification found that the approved ACs required stronger boundary evidence for exact 50 MiB streaming, concurrent same-ID upload, deletion failure ordering, and Web interactions. Those gaps were closed with tests against the existing design; no new production subsystem was introduced.

## Verification

- Attachment storage/routes, Session input, and store projection: 91 focused tests passed.
- Attachment read permission and Bash finite-read policy: 56 focused tests passed.
- Strict `file_read` and model-visible contract: 35 focused tests passed.
- Model projection, verified attachment read paths, and Query-loop integration: 30 focused tests passed.
- Runtime/Agent construction, deletion coordination, Session restart, Web API, and Composer coverage passed in their focused suites.
- Real Browser QA passed at 1280×720 and 390×844:
  - two ordered attachments selected and uploaded sequentially;
  - attachment-only Send enabled and committed to the timeline with both chips;
  - desktop, Composer, attachment list, and 390 px document had no horizontal overflow;
  - browser console reported no errors after the fix.
- Browser QA found one real Bun boundary defect missed by direct route tests: a consumed request-body reader did not provide the optional `releaseLock` method on the second upload. The unnecessary release call was removed, and the same two-file flow then passed end to end.
- The first full test run exposed an architecture-rule collision because the attachment keyed mutex method was named `run`. It was renamed to `withLock`; the architecture rule was not weakened.
- Final `bun run test`: all 8 workspace tasks passed, including unit, integration, interaction, and architecture lanes.
- Final `bun run build`: all 5 workspace typechecks, Vite production build, temporary entry generation, and Bun binary compilation passed.
- `git diff --check` passed. Targeted production searches found no attachment quota/config, chunking, base64 transport, folder upload, parser/OCR/indexing, CAS/GC, or provider/model special-case subsystem.

## Review

- Independent Sol(xhigh) review completed an explicit review → fix → review loop.
- The reviewer found and verified fixes for:
  - inconsistent attachment name/media-type validation between upload, protocol guards, and Session reload; all three now use protocol-owned validators, with an upload → message → restart regression;
  - missing HTTP mapping for invalid attachment references; one Server adapter now maps attachment-domain failures for both upload/download and message routes;
  - a text-only queued message edited to empty returning an internal error; it now returns a domain conflict while attachment-bearing messages may still use empty text;
  - missing acceptance evidence for Todo Discussion attachment input, exactly 10 attachments, and message POST retry reusing original attachment IDs.
- Final Sol(xhigh) verdict: AC-01 through AC-09 all pass; no blocking or major findings remain.
- Final status: **DONE / ready for user review**.

## Residual Risks

- Model modalities remain user-declared; invalid declarations fail through the ordinary sanitized model error path.
- A message can reference up to roughly 500 MiB of images, so an image-capable model call can have a high memory peak.
- There is no cumulative quota, background GC, or orphan scan; best-effort root cleanup may leave an orphan after a logged failure.
- `.archcode/attachments` is ordinary workspace data rather than an OS sandbox; an Agent or user with Bash/filesystem authority can still modify it.
