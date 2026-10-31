---
name: fiction-translation
description: Evidence-based literary translation with stable character voices, directional relationship speech rules, approved original-translation anchors, and independent reviewer checks.
version: 5
---

# Fiction Translation Workflow

Use this skill only for literary documents (novels, stories, memoir, dialogue-heavy nonfiction). It is a workflow contract, not an instruction to create a separate agent for each character.

## Required order

1. **Read source structure.** Keep each stable segment ID, source text, chapter path, and page/layout markers. Never put book memory into `contextPath`; that field is source-document structure only.
2. **Scan the whole book before selecting deep-read samples.** Use the local deterministic scan for chapter coverage, dialogue signals, repeated phrases, and name candidates; sample beginning/middle/end and representative chapters, then use candidate mentions to add early/middle/late evidence for recurring characters. Treat lexical candidates as sampling hints, not entity truth. The planner's sampling reasons and source positions must remain inspectable.
3. **Complete full-book Context Graph preprocessing before the first literary translation call.** Pin the current source revision and language pair. The graph analysis version must match the service's current version; require a supported A/B strategy, non-empty analysis samples, all required style fields and at least one style rule. For strategy B, all five checkpoints (style, characters, entities, relationships, chapters) must be complete. A completed status alone is insufficient. If preprocessing failed, is stale, belongs to another source/language, or is incomplete, stop before translation; do not silently fall back to chapter-by-chapter analysis. The extension performs the normal UI readiness check, and executeRun repeats the authoritative server-side gate.
4. **Load the immutable memory snapshot.** A run pins a `literary_memory_revision_id`. Use its confirmed entity mappings, confirmed character profiles, confirmed directional relationship rules, and approved voice anchors as read-only data.
5. **Translate the batch.** Select a compact, batch-relevant `voiceContext`, including the matching chapter summary and up to two preceding summaries only when the current chapter can be identified reliably. If chapter names do not align, omit chapter summaries rather than risk leaking unrelated or later plot events. Do not send the entire novel, entire memory, or all voice anchors for every batch. Never infer a speaker merely because a name appears nearby. Current source segments always outrank summaries; summaries must not add facts to the translation.
6. **Validate the result.** Preserve one output per input ID, order/segment boundaries, negation, tense, viewpoint, referents, ambiguity, and plot facts. Do not add catchphrases, dialect, swearing, emotions, metaphors, or facts absent from the source merely to make a character sound distinctive.
7. **Review separately.** For Chinese literary targets, run the source-blind Chinese copyedit first, then run the bilingual accuracy/terminology review against the edited candidate. The Chinese editor receives only the Chinese draft and a target-language-only projection of confirmed style/persona memory; it must not receive source text, source quotations, source names, glossary source forms, source summaries, or source-side voice anchors. Its findings cite exact Chinese `targetExcerpt` evidence. The following bilingual reviewer receives source + initial draft + edited candidate and checks semantic fidelity, terminology, viewpoint, ambiguity and literary-device preservation. For non-Chinese targets, retain the existing reviewer path. Character-voice findings from bilingual review should cite exact source/draft evidence and the relevant confirmed profile or directional relationship rule.
8. **Gate changes.** Accuracy and terminology findings may follow the existing must-fix workflow. Style and character-voice revisions remain candidate proposals until explicitly accepted. Model output cannot mark a profile or anchor as user-approved.
9. **Persist evidence and outcome.** Save candidates, findings, source/Prompt/memory revision IDs, run events, and explicit user acceptance in the document project. Do not overwrite a confirmed profile or approved anchor when new chapter analysis disagrees.

## Chinese target-voice profile

- A book-level `chineseEditorialProfile` is distinct from the source-side Context Graph style description. It is derived only from user-accepted Chinese translations.
- The service may use source segments locally for BookScan sample selection, but the profile-analysis model receives only Chinese accepted target text and opaque segment IDs. Never pass source text, source quotes, source names, glossary entries or Context Graph payloads to this profile-analysis task.
- Generated profiles remain `candidate` until the user explicitly confirms them through the Project Store review endpoint. Candidates are never injected into translation or editing prompts.
- Confirmation is bound to the current source revision and at least three accepted target-evidence excerpts. A stale source revision or invalid target evidence downgrades the profile to candidate.
- Only the confirmed profile's concise style fields are injected; sample excerpts and plot-bearing text are not injected. Do not use this profile as evidence about source meaning or character facts.

## Chinese monolingual editing contract

- Chinese literary runs execute Style Review as a source-blind Chinese editor before bilingual accuracy/terminology review. This reuses the existing styleReview and accuracyReview task profiles; it does not create another agent or another parallel pipeline.
- The editor input contains only segment ID, Chinese draft, segment kind/path and target-only memory. The source text is omitted from the model prompt even though the service retains it for later bilingual verification and audit.
- Target-only memory strips canonical source names, aliases, source quotations, source evidence, relationships, source summaries, source glossary forms and source dialogue. It retains confirmed Chinese style guidance, Chinese character names, target-language voice descriptions and approved Chinese dialogue examples.
- Every style finding must quote a continuous `targetExcerpt` from the exact Chinese draft. The complete edited paragraph is stored as a pending `proposedTranslation`; it is not automatically written over the accepted translation.
- The subsequent bilingual accuracy/terminology reviewer receives the edited candidate as its draft and the original source plus the initial draft as comparison context. The initial draft is not treated as authoritative; the source remains the fidelity reference. If the editor fails, the original draft proceeds unchanged. If bilingual review fails, the style proposal remains pending and the run records the review warning; it is not marked as bilingual-verified.
- Non-Chinese literary targets retain the existing review behavior.

## Memory contract

- `characterVoices`: stable `characterId`, canonical source name, aliases, status, voiceCore, contrastRules, evidence, openQuestions.
- `relationshipVoiceRules`: directional speaker → addressee, address terms, baseline register, directness, emotional distance, scene-dependent shifts, source evidence IDs.
- `voiceAnchors`: short original/accepted-translation pairs tied to a real segment and speaker. Only `status=approved` anchors enter normal translation context.
- All generated records start as `candidate`. A voice profile requires at least one source quote that matches its referenced segment. A voice anchor additionally requires `attributionEvidence` to match the same source segment and `attributionConfidence >= 0.7`; approval also requires a confirmed speaker profile and an anchor target that occurs in the current accepted translation for that segment. The Project Store revalidates these conditions server-side.
- Merge is conservative: user-confirmed voice cores and user-approved/rejected states survive future analysis. Conflicting new observations create an open question instead of silently changing the profile.
- Keep memory as an independent immutable revision, not a growing static Prompt. Each Run references the exact memory revision used.

## Unified context, chronology and book-level quality gates

- Each literary batch gets a single persisted `TranslationBrief` pinned to the run's source, Prompt and literary-memory revisions. The initial translator and bilingual accuracy Reviewer receive the same immutable TranslationBrief and context hash. The Chinese monolingual editor deliberately receives a smaller target-only projection instead: Chinese draft segments, confirmed Chinese style guidance, Chinese character-voice descriptions and approved Chinese dialogue anchors. Never pass the full TranslationBrief, glossary, Context Graph, preceding source segments or source-bearing voice context into that editor. In literary mode, glossary terms are eligible only after their canonical source term has appeared before the first segment of the batch, and aliases are filtered by the same source boundary.
- Context is bounded to 18,000 serialized characters after whole-record trimming. The brief stores selected segment IDs, context hash/size, knowledge boundary and retrieval counts. Source text in the current batch and its exact IDs remain separate from memory; preceding segments are context only, never output segments.
- A graph node/edge is eligible only when all its stored evidence ordinals precede the batch's first source ordinal. Previous chapters may use their complete summary; the current chapter must use only a prefix summary derived from source segments strictly before the batch. Never inject a whole current-chapter summary into an early batch.
- Run the book-level quality audit after a full translation/review pass. It reports missing segments, confirmed-term drift heuristics, written-out or digit-based numeric-value mismatches, quantity-unit drift (for example, inches versus feet), repeated exact source passages with translation variation, persisted duplicate/unknown/malformed model-output rows for an explicitly audited Run, and recorded voice/style findings. Numeric and unit mismatches are heuristic warnings: Chinese number words, classifiers, locale-specific formats, and valid unit conversions can differ; review them against the source rather than treating them as proven errors. Output-shape anomalies are logged as run events and must never be accepted as translations. Findings are review targets, not automatic corrections.
- Targeted repair must create a separate selected-segment Run and preserve all accepted/manual translations. Do not auto-accept repair output. The human must explicitly accept a candidate through the existing acceptance gate.
- Compare before/after only when source revision, language direction and exact segment IDs match and both runs are finished. Record model call count, prompt characters and measured duration where available; do not estimate token/dollar cost when the provider exposes no billing data. Keep the A/B mapping hidden until every sampled passage has an overall blind rating.

## Output and caching

- Put voice data into an explicit read-only user-data field named `voiceContext`; never concatenate it into `contextPath`. For dialogue/coreference disambiguation, pass at most four preceding source segments in a separate read-only `precedingSegments` field; do not ask the model to translate or return IDs for them.
- Bound by removing lower-priority complete records, not by slicing serialized JSON.
- Include the voice-context and preceding-context/policy hash in the literary translation cache key, including caller-supplied keys. The current policy version is `character-voice-v3`. Keep non-literary/web cache keys unchanged.
- Record policy version and memory revision with each run. Never reuse a candidate produced with a different source hash, static Prompt, or voice context when deciding whether a result is current.

## Review checklist

Before completing a literary batch, ask:
- Is the speaker/addressee actually supported by the source and scene?
- Does this line differ from that character's confirmed baseline in register, syntax/rhythm, lexical preferences, discourse habit, stance/modality, humor/irony, or disfluency?
- Does the difference have textual evidence, or is it an unsupported stereotype?
- Is a relationship rule directional and scene-appropriate?
- Is the proposed change more faithful and readable without adding content?
- Has the model kept the current translation if the finding is merely stylistic and not accepted?

When there is no reliable character-voice evidence, prefer a faithful, natural translation over an invented voice signature.


- Chinese literary quality audits expose separate counts for reviewed, edited, unchanged and uncovered segments; bilingual verification states; and user apply/dismiss decisions. Never interpret an absent review as a successful unchanged review.
- Treat `manuallyOverriddenAfterApplyCount` as a subsequent manual override signal, not a definitive over-edit/error label.


## Benchmarking

- Use the local Chinese Literary Editing Benchmark harness for model A/B comparisons on 100–200 public-domain, user-owned or explicitly licensed segments. The source text is used for bilingual fidelity screening and human review; the Chinese monolingual editor prompt receives only the Chinese draft and target-only context.
- Keep blind-review-packet.json separate from blind-mapping.json until human ratings are locked. Use the same bilingual reviewer model for both candidate sets and do not use an LLM judge as the sole winner selector.
