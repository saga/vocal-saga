# Diagnostic Bundle Review — 2026-11-01

## Scope

Reviewed the uploaded bundle `local-agent-diagnostics-2026-10-31T23-30-12-990Z.tar.gz`, covering two EPUB projects, their Run/event histories, TranslationBrief size metadata, and the bounded service log excerpt. This review uses the bundle as evidence and checks the current `main` implementation before changing it.

## Findings and changes

### P1 — Translation result count was a collector defect

The bundle reported `translationResultCount: 0` for both projects even though the run state and events showed accepted translations.

Root cause: the collector selected `provider` and `model` from `translation_results`, but those columns belong to `translation_runs`. The SQL query therefore failed. The shared `rows()` helper returned an object containing `collectionError`, and `asArray()` silently converted that object to an empty array. The collector consequently reported zero rows instead of exposing the failed query.

Changes:
- Join `translation_results` to `translation_runs` to obtain provider/model metadata.
- Record SQL collection failures in `collectionQueryErrors` instead of silently presenting them as empty data.
- Separate the persisted context character count (`brief_chars`) from the larger serialized SQLite JSON size.

### P1 — Automatic quality repair previously escaped the parent Run scope

The uploaded bundle contains two historical examples:
- A parent Run with 11 selected segments produced an automatic repair Run with 100 segments.
- A parent Run with 21 selected segments produced an automatic repair Run with 100 segments.

The repair samples begin at `epub-title` and early segments from another part of the EPUB, rather than the selected parent scope. These are genuine out-of-scope repairs, not merely a misleading summary count.

The current `main` implementation already contains the server-side correction:
- Automatic repair only accepts explicitly selected, repairable `missing-translation` findings.
- Every selected segment must belong to the parent Run's `run_segments`.
- The parent must be completed/partial and match the current source revision.
- `quality-audit.test.mjs` includes a regression test proving that an out-of-scope finding is rejected and an in-scope finding is accepted.

No duplicate implementation was added. The diagnostic collector now retains parent-scope count, in-scope/out-of-scope missing counts, and the scope policy from repair events, so a future bundle can verify this behavior directly.

### P1 — Context was not sufficiently attributable

The bundle's log excerpt showed:

```text
voice-context built · entities=5 · relationships=0 · characterVoices=0
  · voiceAnchors=0 · dialogueParticipants=0 · chars=78736

translation-brief assembled · segments=5 · chars=101842
  · graphMappings=82 (strong=4) · voiceEntities=5 · voiceCharacters=0
```

This is a real observability gap: the previous bundle showed total sizes and item counts, but not which sections accounted for the 78K characters. It therefore could not distinguish a large editorial profile, many accepted examples, entity evidence, style data, or another section.

Code inspection also found an overly broad canonical-mapping projection. Previously, a mapping could be injected because its name had appeared anywhere earlier in the book, even when the name was not present in the current batch or its configured preceding context. In this example the brief had 82 mappings, only 4 of them strong, while the voice projection contained 5 entities.

Changes:
- Canonical name mappings are now filtered to names actually present in the current batch or its configured preceding segments. An unrelated name mentioned hundreds of pages earlier is retrieved again when it becomes relevant; it no longer inflates every intervening batch.
- Added counters for mappings before filtering and mappings excluded because they are not mentioned in the current batch context.
- Bumped the TranslationBrief policy version to `translation-brief-v9-batch-scoped-mappings`.
- Voice-context logs now report the largest section sizes and recent-example origin counts, without logging content.
- TranslationBrief records per-component character counts and per-array item count/size distribution for glossary, preceding segments, Context Graph, and voice context.
- The collector parses saved TranslationBrief JSON in memory and exports only counts, character lengths, maximum/median item lengths, and duplicate-item counts. It never exports the component text.

The accepted-example retriever still intentionally selects every materially relevant, diverse accepted example; it has no final hard cap. The old bundle cannot show whether those examples, the Chinese editorial profile, or another section caused the 78K size. I have not introduced an arbitrary cap before seeing the new component breakdown, because that could remove useful literary evidence. The next v3 bundle will identify the actual dominant section and allow a targeted retrieval change.

### P1 — Reviewer success/failure and coverage were not visible

The bundle showed multiple `review.audit.failed` events (six in one project) but did not make it easy to distinguish:
- input segment count,
- returned translation count,
- reviewed/missing IDs,
- findings returned,
- initial request versus missing-ID retry,
- failed request versus successful partial coverage.

Changes:
- The collector now summarizes Reviewer input/output/failure/retry events by Run and stage.
- It exports only counts, request correlation IDs, timestamps, stage, response shape, and bounded error text; it does not export the review input/output bodies.
- `translation-brief.ready` and Reviewer lifecycle events are now retained in the filtered event timeline.

This is an observability change; it does not change the rule that failed or incomplete bilingual review must fall back to the initial translation rather than accepting an unverified edit.

### P2 — Service logs omitted important context-build details

The log collector now explicitly retains `voice-context`, `translation-brief`, `document-agent`, `literary-review`, Reviewer audit, quality audit/repair, and canonical-term log records. Polling noise and prompt/response previews remain excluded.

## Diagnostic bundle format

The collector schema is now version 3. It adds:
- corrected translation-result metrics and explicit SQLite query errors;
- per-batch context composition metadata;
- accepted-example candidate/retrieval/selection counts;
- Reviewer coverage and failure summaries;
- quality-repair scope metadata;
- separate context size versus serialized storage size.

No source EPUB/PDF, source text, translated text, full Prompt, LiteraryMemory body, raw TranslationBrief, raw context delta, or full event payload is exported.

## Verification status

Regression coverage was extended for batch-scoped canonical mapping retrieval and TranslationBrief component diagnostics. The existing quality-audit tests already cover automatic repair scope enforcement.

The repository was edited through GitHub's file API; there was no local checkout or executable project environment in this session. Therefore `npm test`, `npm run typecheck`, and an end-to-end document translation were **not run**. Do not treat these changes as runtime-verified until CI or a local run confirms them.

## Next diagnostic run

After updating the local service, run:

```bash
npm run diagnose:bundle
```

Inspect `translationBriefs[].contextComposition` for the 5-segment / 100K class of batches. If `voiceContext.recentExamples` dominates, tune accepted-example retrieval based on its candidate and selected counts, item-size distribution, and duplicate rate. If `chineseEditorialProfile`, style data, or graph mappings dominate, address that specific section instead of applying a global character cap.
