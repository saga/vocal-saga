# Chinese Literary Editing Benchmark

This benchmark compares two Chinese monolingual editors on the same initial Chinese drafts. It does not assume that a larger edit distance or a higher edit rate means better editing.

## Dataset

Use 100–200 segments for a formal comparison. Each JSONL row follows dataset.schema.json:

- id: stable unique segment ID.
- source: source passage used only by the later bilingual fidelity reviewer and human reviewers.
- draft: initial Chinese draft supplied to both editors.
- genre: novel, memoir, essay, biography, literary reportage, etc.
- targetLang: zh-CN or zh-TW.
- rights: required provenance. Only public-domain, user-owned or explicitly licensed passages are allowed.

Do not place copyrighted commercial novels in the repository. Keep the dataset in a local ignored directory or a separately permissioned private corpus. Record edition, source URL, copyright/public-domain basis, and any usage restrictions in rights.reference / rights.notes.

## Run

Validate the dataset without model calls:

    npm run benchmark:chinese-literary -- --dataset /path/to/dataset.jsonl --allow-small --validate-only

Run a formal blinded A/B comparison:

    npm run benchmark:chinese-literary -- --dataset /path/to/dataset.jsonl --provider workbuddy --model-a MODEL_A --model-b MODEL_B --accuracy-model REVIEWER_MODEL --output /path/to/results

The formal run requires 100–200 segments. --allow-small is only for connectivity/smoke checks. Batch size defaults to 16 and is capped at 32.

The runner executes:
1. Chinese monolingual editing with Model A.
2. Chinese monolingual editing with Model B.
3. The same bilingual accuracy/terminology reviewer against both candidate sets.
4. A randomized global A/B mapping and a reviewer packet that omits model identities.

No automatic LLM judge score is used to declare a winner.

## Output

- blind-review-packet.json: source, initial draft and anonymized Candidate A/B.
- human-review-template.csv: one row per segment for independent human ratings.
- blind-mapping.json: model identity mapping. Keep this away from human reviewers until ratings are locked.
- model-results.json: raw editor outputs, automated summaries and bilingual reviewer findings.
- run-manifest.json: dataset hash, run ID, model/provider and execution settings.

The script does not upload the dataset or results. The output directory is local to the machine running the benchmark.

## Human rubric

Score each candidate independently, preferably with two reviewers:

| Dimension | What to assess |
|---|---|
| Chinese naturalness | Natural collocations, syntax, particles, translationese, readable flow |
| Narrative voice | Distance, register, tone, authorial restraint and consistency |
| Character voice | Distinct dialogue without invented catchphrases, dialect or emotion |
| Literary rhythm | Long sentences, repetition, pauses, ambiguity, imagery and deliberate awkwardness |
| Fidelity | Omission/addition, negation, viewpoint, reference, tense and tone strength |
| Over-editing | Whether a sound original expression was needlessly changed or its literary effect damaged |

Record preference (A / B / tie), dimension scores, critical fidelity errors and concrete notes. A reviewer must be allowed to prefer the unchanged draft.

## Analysis rules

- Compare the exact same source/draft segment IDs for both models.
- Report edit rate and unchanged rate, but never optimize for either in isolation.
- Treat the bilingual reviewer as a screening signal; manually inspect critical findings.
- Blind the candidate mapping until all human reviews are submitted.
- Report inter-rater agreement and adjudicate disagreements before unblinding.
- Separate style preference from critical fidelity errors. A natural candidate with a meaning regression must not win overall.
- Keep a fixed dataset version and rerun it after prompt, profile or model changes.
- Only public-domain, user-owned or licensed content may enter the benchmark.

A model should become the default editor only after it improves blind human preference without increasing critical fidelity regression or over-editing.
