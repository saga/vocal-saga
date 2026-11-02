# Web Translation Backport Plan — 2026-11-03

## Decision

The Cloudflare Worker is a lightweight, request/response webpage translation service. It is not a smaller copy of `local-agent-service`. Backport only reliability practices that fit the Worker runtime and short webpage scope.

## Scope

### Keep in the default Fast path

- Existing deterministic HTML extraction and block/chunk preparation.
- Existing bounded provider concurrency.
- Existing structured-output parsing and block-ID validation.
- Existing missing-block detection and one bounded retry for missing results.
- Existing block/chunk cache reuse and singleflight behavior.
- Existing site terminology and site-specific instructions.
- No additional LLM calls beyond the normal translation call(s).

### Optional Enhanced Quality mode

A user-facing checkbox in the browser extension opts a remote webpage request into `qualityMode=enhanced`. It is off by default.

Enhanced mode reuses only information already extracted from the page:
- page title;
- up to eight headings;
- the first two paragraph snippets, each bounded to 180 characters.

This compact context is attached to the existing translation prompt. It helps disambiguate the page topic and maintain terminology across chunks. It does not trigger a context-analysis model, a Reviewer, a style review, or a repair pass. No separate LLM call is added.

### Explicitly excluded from the Worker

Do not backport:
- Literary entity/person analysis or character/voice profiles.
- Context Graph, LiteraryMemory, TranslationBrief, book/chapter memory or wave scheduling.
- Full-page or per-chunk Reviewer calls.
- Style review, multi-candidate generation, broad quality audits or iterative rewriting.
- Durable project/run orchestration, checkpoints or human approval workflows.

These remain local document-translation capabilities only.

## Cache and compatibility

- The remote webpage API normalizes legacy `translationMode=literary` inputs to `technical`; this prevents old extension settings from accidentally activating the document/literary pipeline.
- Page-cache fingerprints include `qualityMode` so Fast and Enhanced results cannot collide.
- The page prompt revision is bumped when the web prompt contract changes.
- The extension sends the same quality mode to both cache-check and translation requests.
- Old clients that omit `qualityMode` continue to use Fast.

## Implementation status

- [x] Add the opt-in `webEnhancedQuality` setting, default false.
- [x] Add the checkbox to the remote-server settings panel.
- [x] Send `qualityMode` on both cache-check and translation requests.
- [x] Enforce the technical/lightweight pipeline on the remote webpage route.
- [x] Remove the web-page literary entity-analysis and second-pass Reviewer path.
- [x] Add bounded, deterministic page context for Enhanced mode without an extra model call.
- [x] Separate page cache entries by quality mode and bump the prompt revision.
- [x] Add focused tests for quality-context construction and cache separation.
- [ ] Run the full Worker and extension test/typecheck/build suites in CI and inspect their results.

## Acceptance criteria

1. A request without `qualityMode` behaves as Fast.
2. Fast mode adds no context-analysis or Reviewer calls.
3. Enhanced mode uses only bounded page metadata and does not add a model call.
4. Legacy `translationMode=literary` cannot activate literary analysis/review in remote webpage translation.
5. Fast and Enhanced cache fingerprints differ.
6. Existing concurrency, missing-block retry, validation and cache behavior remain intact.
7. The local Agent/document pipeline remains unchanged.
