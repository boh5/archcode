# Evidence map shape

Use the smallest map that makes the requested change or explanation safe. A useful map connects claims rather than listing directories.

```markdown
## Scope
Question: Where is an incoming request admitted, persisted, and exposed to clients?
Excluded: unrelated page rendering and provider implementation.

## Entry and ownership
- `routes/example.ts#handler` — transport validation and status mapping [source: `routes/example.ts#handler`]
- `domain/service.ts#execute` — domain invariant and mutation owner [source: `domain/service.ts#execute`; test: `domain/service.test.ts` "rejects duplicate commands"]
- `store/repository.ts#save` — persistence boundary [source: `store/repository.ts#save`]

## Primary flow
HTTP input
  -> route schema
  -> domain command
  -> repository commit
  -> event publication
  -> client projection

At each arrow record the concrete type/value, sync or async ordering, error path,
and whether the boundary mutates state.

## Invariants and impact
- Invariant: only the domain service may create the durable record [test: `architecture/ownership.test.ts` "keeps record creation in the domain service"].
- Direct consumers: `routes/example.ts#handler` and `domain/service.test.ts` [references: `rg -n "service\\.execute" routes domain`].
- Transitive impact: `contracts/example-event.ts#ExampleCreated` is consumed by the client projection [evidence: `client/projector.ts#applyExampleCreated`].

## Unknowns
- Unknown: whether retry can publish a duplicate event.
- Next probe: inspect idempotency key ownership and the retry integration test.
```

Evidence tags should resolve to a file plus symbol or tight line, a named test whose assertion proves the claim, a reproducible command observation, or an authoritative external contract. The names above are illustrative placeholders for a hypothetical repository; replace every one with a locator from the repository being mapped. “This folder seems responsible” and “tests pass” are not evidence locators.

Prefer one primary happy path plus the material alternate paths: validation failure, authorization denial, partial persistence, retry/restart, and cancellation only when they affect the question. End the map when a reader can identify the owner to change, its callers, the invariants to preserve, and the next unresolved probe.

For each material statement, attach a file and symbol, relevant test, or command observation. The map is complete when the requested change can be placed safely; it is not an inventory of the repository.
